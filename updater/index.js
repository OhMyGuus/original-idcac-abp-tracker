import * as fsAsync from "fs/promises";
import * as fs from "fs";
import fetch from "node-fetch";
import Seven from "node-7z";
import js from "js-beautify";

const abpLists = [
  ["https://www.i-dont-care-about-cookies.eu/abp/", "IDCABC-ABP.txt"],
  [
    "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt",
    "easylist-cookies-ABP.txt",
  ],
   [
    "https://secure.fanboy.co.nz/fanboy-cookiemonster_ubo.txt",
    "easylist-fanboy-cookiemonster_ubo.txt",
  ],
];

async function updateIDCAC() {
  const response = await fetch(
    "https://addons.mozilla.org/firefox/downloads/latest/i-dont-care-about-cookies/i-dont-care-about-cookies-latest.xpi"
  );
  if (!(await fs.existsSync("tmp"))) {
    await fsAsync.mkdir("tmp");
  }
  fsAsync.writeFile(
    "tmp/IDCAC-original.zip",
    Buffer.from(await response.arrayBuffer()),
    "binary",
    function (err) {}
  );

  const zipStream = Seven.extractFull(
    "tmp/IDCAC-original.zip",
    "IDCAC-original",
    {
      $progress: true,
    }
  );
  zipStream.on("error", () => {
    console.error("7z error");
    process.exit(1);
  });

  zipStream.on("end", async () => {
    var rules = await fsAsync.readFile("IDCAC-original/data/rules.js", {
      encoding: "utf8",
    });
    await fsAsync.writeFile(
      "IDCAC-original/data/rules.js",
      js.js_beautify(rules)
    );
  });
}

async function updateABPlists() {
  for (let list of abpLists) {
    var newList = await fetchList(list[0]);
    let newListSplit = newList.split(/\r?\n/);

    if (await fs.existsSync(list[1])) {
      let oldList = (
        await fsAsync.readFile(list[1], {
          encoding: "utf8",
        })
      ).split(/\r?\n/);
      if (newListSplit.length == oldList.length) {
        let update = false;
        for (let i = 0; i < oldList.length; i++) {
          if (
            !oldList[i].startsWith("!") &&
            !oldList[i].startsWith("[") &&
            oldList[i] != newListSplit[i]
          ) {
            update = true;
            break;
          }
        }
        if (!update) {
          continue;
        }
      }
    }
    if (newListSplit.length < 20) {
      console.error("Error with fetching list: ", list[1]);
      process.exit(1);
    }

    await fsAsync.writeFile(list[1], newList);
  }
}

async function fetchList(url) {
  const response = await fetch(url);
  return await response.text();
}

async function start() {
  await updateABPlists();
  await updateIDCAC();
}

start();
