import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";

const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../src/server.js", import.meta.url), "utf8");

test("conversations view does not render the summary card strip", () => {
  assert.doesNotMatch(html, /<div class="stats" id="stats"><\/div>/);
  assert.doesNotMatch(app, /#stats/);
});

test("human filter shows unread human conversation count", () => {
  assert.match(html, /id="human-unread"/);
  assert.match(app, /summary\.humanUnread/);
  assert.match(server, /humanUnread/);
  assert.match(server, /control_mode = 'human' AND unread_count > 0/);
});

test("chat banners can be dismissed", () => {
  assert.match(app, /dismissible-banner/);
  assert.match(app, /data-dismiss-banner/);
  assert.match(css, /\.banner-close/);
});
