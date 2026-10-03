import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPublicOnlyLookup,
  fetchPublicUrl,
  isGoogleHost,
  isPrivateAddress,
  parsePublicUrl,
  RemoteFetchError,
  toDirectFileUrl,
  toSheetCsvUrl,
} from "../src/services/remoteFetch.js";

test("loopback, private, link-local and metadata addresses are private", () => {
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
});

test("ordinary internet addresses are public", () => {
  for (const address of ["8.8.8.8", "142.250.183.14", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("something that is not an address is refused, not guessed at", () => {
  assert.equal(isPrivateAddress("not-an-ip"), true);
  assert.equal(isPrivateAddress(""), true);
});

test("only plain http and https links on the standard ports are accepted", () => {
  assert.equal(parsePublicUrl("https://example.com/a.jpg").hostname, "example.com");
  assert.equal(parsePublicUrl("http://example.com:80/a.jpg").hostname, "example.com");
  for (const link of [
    "ftp://example.com/a.jpg",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com/a.jpg",
    "https://example.com:8080/a.jpg",
    "not a link",
    "",
  ]) {
    assert.throws(() => parsePublicUrl(link), RemoteFetchError, link);
  }
});

test("links naming a private host outright are refused before any request", () => {
  for (const link of [
    "http://127.0.0.1/a.jpg",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/a.jpg",
    "http://localhost/a.jpg",
    "http://api.localhost/a.jpg",
    "http://metadata.google.internal/",
  ]) {
    assert.throws(() => parsePublicUrl(link), /private address/, link);
  }
});

test("a hostname that resolves only to private addresses is refused", async () => {
  const lookup = createPublicOnlyLookup((_host, _options, done) => done(null, [
    { address: "127.0.0.1", family: 4 },
    { address: "169.254.169.254", family: 4 },
  ]));
  const error = await new Promise((resolve) => lookup("evil.example", {}, resolve));
  assert.ok(error instanceof RemoteFetchError);
  assert.match(error.message, /private address/);
});

test("a hostname with public and private answers connects only to the public one", async () => {
  const lookup = createPublicOnlyLookup((_host, _options, done) => done(null, [
    { address: "10.0.0.5", family: 4 },
    { address: "93.184.216.34", family: 4 },
  ]));
  const single = await new Promise((resolve) => lookup("mixed.example", {}, (error, address, family) => resolve({ error, address, family })));
  assert.deepEqual(single, { error: null, address: "93.184.216.34", family: 4 });
  const all = await new Promise((resolve) => lookup("mixed.example", { all: true }, (error, addresses) => resolve(addresses)));
  assert.deepEqual(all, [{ address: "93.184.216.34", family: 4 }]);
});

test("allowHost stops a fetch before it leaves the machine", async () => {
  await assert.rejects(
    fetchPublicUrl("https://example.com/sheet.csv", { allowHost: () => false }),
    /not allowed/,
  );
});

test("Google Drive share links become direct downloads", () => {
  assert.equal(
    toDirectFileUrl("https://drive.google.com/file/d/1AbC_d-9/view?usp=sharing"),
    "https://drive.google.com/uc?export=download&id=1AbC_d-9",
  );
  assert.equal(
    toDirectFileUrl("https://drive.google.com/open?id=XYZ123"),
    "https://drive.google.com/uc?export=download&id=XYZ123",
  );
});

test("Dropbox links ask for the file rather than the preview page", () => {
  assert.equal(
    toDirectFileUrl("https://www.dropbox.com/s/abc/photo.jpg?dl=0"),
    "https://www.dropbox.com/s/abc/photo.jpg?dl=1",
  );
});

test("any other link is left exactly as written", () => {
  assert.equal(toDirectFileUrl("https://cdn.example.com/p/1.jpg"), "https://cdn.example.com/p/1.jpg");
  assert.equal(toDirectFileUrl("  not a url "), "not a url");
});

test("a Google Sheets link becomes its CSV export, keeping the tab", () => {
  assert.equal(
    toSheetCsvUrl("https://docs.google.com/spreadsheets/d/1Sheet_Id-x/edit#gid=12345"),
    "https://docs.google.com/spreadsheets/d/1Sheet_Id-x/export?format=csv&gid=12345",
  );
  assert.equal(
    toSheetCsvUrl("https://docs.google.com/spreadsheets/d/1Sheet_Id-x/edit?usp=sharing"),
    "https://docs.google.com/spreadsheets/d/1Sheet_Id-x/export?format=csv",
  );
  assert.equal(
    toSheetCsvUrl("https://docs.google.com/spreadsheets/d/1Sheet/edit?gid=7#gid=7"),
    "https://docs.google.com/spreadsheets/d/1Sheet/export?format=csv&gid=7",
  );
});

test("a published sheet link becomes its published CSV", () => {
  assert.equal(
    toSheetCsvUrl("https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml?gid=3"),
    "https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv&gid=3",
  );
});

test("a link that is not a Google Sheet is not treated as one", () => {
  assert.equal(toSheetCsvUrl("https://example.com/spreadsheets/d/abc"), null);
  assert.equal(toSheetCsvUrl("https://docs.google.com/document/d/abc/edit"), null);
  assert.equal(toSheetCsvUrl("nonsense"), null);
});

test("only Google's own hosts count for a sheet download", () => {
  assert.equal(isGoogleHost("docs.google.com"), true);
  assert.equal(isGoogleHost("doc-0s-sheets.googleusercontent.com"), true);
  assert.equal(isGoogleHost("evil-google.com"), false);
  assert.equal(isGoogleHost("docs.google.com.evil.com"), false);
});
