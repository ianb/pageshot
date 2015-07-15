const { AbstractShot } = require("../shared/shot");
const db = require("./db");

class Shot extends AbstractShot {

  constructor(ownerId, backend, id, attrs) {
    super(backend, id, attrs);
    this.ownerId = ownerId;
  }

  convertAnyDataUrls(client, json, possibleClipsToInsert) {
    return Promise.all(
      possibleClipsToInsert.map((clipId) => {
        let clip = this.getClip(clipId);
        console.log("clip", clipId);
        try {
          let data = clip.imageBinary();
        } catch (e) {
          if (e.message !== "Bad clip URL") {
            throw e;
          }
          // It's already in the db, and the clip has an http url
          return true;
        }
        console.log("we need to put it in the db", data);
        return db.queryWithClient(
          client,
          "INSERT INTO images (id, image) VALUES ($1, $2)",
          [`${this.id}/${clipId}`, data]
        ).then((rows) => {
          if (rows.rowCount) {
            // TODO replace url here
          } else {
            throw new Error("no row inserted");
          }
          return rows;
        });
        // TODO if the client provided us a data url but that clip is already in the
        // db, we need to update the existing record with the value in the data url
      })
    );
  }

  insert() {
    let json = this.asJson();
    let possibleClipsToInsert = this.clipNames();
    return db.transaction((client) => {
      return db.queryWithClient(
        client, "SELECT id FROM data WHERE id = $1", [this.id]
      ).then((rows) => {
        if (rows.rowCount) {
          // duplicate key
          console.log("duplicate key");
          return false;
        }

        // If the key doesn't already exist, go through the clips being inserted and
        // check to see if we need to store any data: url encoded images
        console.log("checking clips", possibleClipsToInsert);
        return this.convertAnyDataUrls(client, json, possibleClipsToInsert).then((oks) => {
          console.log("got all the way to insert!", oks);
          return db.queryWithClient(
            client,
            `INSERT INTO data (id, deviceid, value)
             VALUES ($1, $2, $3)`,
            [this.id, this.ownerId, JSON.stringify(json)]
          ).then((rows) => {
            console.log("inserted?", rows.rowCount);
            return true;
          });
        });
      });
    });
  }

  update() {
    let json = this.asJson();
    let possibleClipsToInsert = this.clipNames();
    return db.transaction((client) => {
      return this.convertAnyDataUrls(client, json, possibleClipsToInsert).then((oks) => {
        return db.queryWithClient(
          client,
          `UPDATE data SET value = $1 WHERE id = $2 AND deviceid = $3`,
          [JSON.stringify(json), this.id, this.ownerId]
        ).then((rowCount) => {
          if (! rowCount) {
            throw new Error("No row updated");
          }
        });
      });
    });
  }

}

exports.Shot = Shot;

class ServerClip extends AbstractShot.prototype.Clip {
  imageBinary() {
    if (! (this.image && this.image.url)) {
      throw new Error("Not an image clip");
    }
    let url = this.image.url;
    let match = (/^data:([^;]*);base64,/).exec(url);
    if (! match) {
      throw new Error("Bad clip URL");
    }
    let imageData = url.substr(match[0].length);
    imageData = new Buffer(imageData, 'base64');
    return {
      contentType: match[1],
      data: imageData
    };
  }
}

Shot.prototype.Clip = ServerClip;

Shot.get = function (backend, id) {
  return Shot.getRawValue(id).then((rawValue) => {
    if (! rawValue) {
      return null;
    }
    let json = JSON.parse(rawValue.value);
    return new Shot(rawValue.userid, backend, id, json);
  });
};

Shot.getRawValue = function (id) {
  if (! id) {
    throw new Error("Empty id: " + id);
  }
  return db.select(
    `SELECT value, deviceid FROM data WHERE id = $1`,
    [id]
  ).then((rows) => {
    if (! rows.length) {
      return null;
    }
    let row = rows[0];
    return {
      userid: row.deviceid,
      value: row.value
    };
  });
};

Shot.getShotsForDevice = function (backend, deviceId) {
  if (! deviceId) {
    throw new Error("Empty deviceId: " + deviceId);
  }
  let timeStart = Date.now();
  let timeMid;
  return db.select(
    `SELECT DISTINCT devices.id
     FROM devices, devices AS devices2
     WHERE devices.id = $1
           OR (devices.accountid = devices2.accountid
               AND devices2.id = $1)
    `,
    [deviceId]
  ).then((rows) => {
    timeMid = Date.now();
    let ids = [];
    let idNums = [];
    for (let i=0; i<rows.length; i++) {
      ids.push(rows[i].id);
      idNums.push("$" + (i+1));
    }
    return db.select(
      `SELECT data.id, data.value, data.deviceid
       FROM data
       WHERE data.deviceid IN (${idNums.join(", ")})
       ORDER BY data.created
      `,
      ids
    );
  }).then((rows) => {
    console.info("Index query:", Date.now() - timeStart, "ms total; device query:", timeMid - timeStart, "ms");
    let result = [];
    for (let i=0; i<rows.length; i++) {
      let row = rows[i];
      let json = JSON.parse(row.value);
      let shot = new Shot(row.deviceid, backend, row.id, json);
      result.push(shot);
    }
    return result;
  });
};
