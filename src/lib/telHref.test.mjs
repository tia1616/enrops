import assert from "node:assert/strict";
import { telHref } from "./telHref.js";

assert.equal(telHref("(503) 555-1234"), "tel:5035551234");
assert.equal(telHref("+1 503.555.1234"), "tel:+15035551234");
assert.equal(telHref("503-555-1234 x2"), "tel:5035551234");
assert.equal(telHref("503-555-1234 ext. 44"), "tel:5035551234");
assert.equal(telHref("503 555 1234 (cell)"), "tel:5035551234");
assert.equal(telHref("503-555-1234 #9"), "tel:5035551234");
assert.equal(telHref("Cell: 503-555-1234"), "tel:5035551234");
assert.equal(telHref("Cell: 503-555-1234 ext 2"), "tel:5035551234");
assert.equal(telHref("call me"), null);
assert.equal(telHref("+"), null);
assert.equal(telHref(""), null);
assert.equal(telHref(null), null);
assert.equal(telHref(undefined), null);
console.log("telHref: ok");
