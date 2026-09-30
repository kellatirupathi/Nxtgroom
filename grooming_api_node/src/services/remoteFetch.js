import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Downloads a file from a link someone pasted into a spreadsheet.
 *
 * The instructor import fetches photographs and Google Sheets from addresses
 * the server did not choose, so the fetch refuses anything that resolves to
 * this machine or the private network behind it. The check runs inside the
 * socket's own DNS lookup rather than before the request, so a hostname cannot
 * pass the check on one lookup and connect somewhere private on the next.
 */

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

export class RemoteFetchError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = "RemoteFetchError";
    this.status = status;
  }
}

function ipv4Parts(address) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

/**
 * Whether an address belongs to this host or a network that is not the public
 * internet: loopback, private ranges, link-local (which includes the cloud
 * metadata service at 169.254.169.254), carrier-grade NAT, multicast and the
 * reserved blocks. IPv4 addresses mapped into IPv6 are judged as IPv4.
 */
export function isPrivateAddress(address) {
  const value = String(address || "").trim().toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]);

  if (net.isIPv4(value)) {
    const [a, b] = ipv4Parts(value);
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224;
  }

  if (net.isIPv6(value)) {
    return value === "::"
      || value === "::1"
      || value.startsWith("fc")
      || value.startsWith("fd")
      || /^fe[89ab]/.test(value)
      || value.startsWith("ff");
  }

  // Not an address at all: refuse rather than guess.
  return true;
}

/**
 * A DNS lookup with every private answer removed. Used as the socket's lookup,
 * so the address that was checked is the address that is connected to.
 */
export function createPublicOnlyLookup(resolve = dns.lookup) {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const allowed = addresses.filter((entry) => !isPrivateAddress(entry.address));
      if (!allowed.length) {
        return callback(new RemoteFetchError("This link points to a private address and cannot be opened"));
      }
      if (options?.all) return callback(null, allowed);
      return callback(null, allowed[0].address, allowed[0].family);
    });
  };
}

const publicOnlyLookup = createPublicOnlyLookup();

/**
 * Parses and checks one link. Only plain http(s) on the standard ports, with
 * no user name or password in it; a literal IP address must be public.
 */
export function parsePublicUrl(value) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new RemoteFetchError("The link is not a valid web address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RemoteFetchError("The link must start with http:// or https://");
  }
  if (url.username || url.password) {
    throw new RemoteFetchError("The link must not contain a user name or password");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new RemoteFetchError("The link must use the standard web port");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isPrivateAddress(host)) {
    throw new RemoteFetchError("This link points to a private address and cannot be opened");
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new RemoteFetchError("This link points to a private address and cannot be opened");
  }
  return url;
}

function requestOnce(url, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    const request = client.get(url, {
      lookup: publicOnlyLookup,
      timeout: timeoutMs,
      headers: {
        "user-agent": "FacultyTrack-Import/1.0",
        accept: "*/*",
      },
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve({ redirect: response.headers.location, status });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new RemoteFetchError(`The link returned an error (HTTP ${status})`, { status }));
        return;
      }
      const declared = Number(response.headers["content-length"] || 0);
      if (declared > maxBytes) {
        response.destroy();
        reject(new RemoteFetchError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          reject(new RemoteFetchError(`The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({
        buffer: Buffer.concat(chunks),
        contentType: String(response.headers["content-type"] || "").toLowerCase(),
        status,
      }));
      response.on("error", (error) => reject(new RemoteFetchError(error.message || "The download failed")));
    });
    request.on("timeout", () => {
      request.destroy(new RemoteFetchError("The link took too long to respond"));
    });
    request.on("error", (error) => {
      reject(error instanceof RemoteFetchError
        ? error
        : new RemoteFetchError("The link could not be opened"));
    });
  });
}

/**
 * Downloads one public link, following redirects and re-checking each hop.
 *
 * `allowHost` narrows which hosts may be reached at all, so the sheet import
 * can insist on Google while a photograph may come from anywhere public.
 */
export async function fetchPublicUrl(link, {
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  allowHost = () => true,
} = {}) {
  let url = parsePublicUrl(link);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (!allowHost(url.hostname)) {
      throw new RemoteFetchError("The link goes to a site that is not allowed here");
    }
    const result = await requestOnce(url, { timeoutMs, maxBytes });
    if (!result.redirect) return { ...result, url: url.toString() };
    url = parsePublicUrl(new URL(result.redirect, url).toString());
  }
  throw new RemoteFetchError("The link redirected too many times");
}

/**
 * The direct-download form of a share link, for the hosts people commonly
 * paste. A Google Drive "view" page is HTML, not the photograph, and Dropbox
 * serves a preview page unless asked for the file. Anything else is returned
 * unchanged.
 */
export function toDirectFileUrl(link) {
  const text = String(link || "").trim();
  let url;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  if (url.hostname === "drive.google.com") {
    const fromPath = url.pathname.match(/\/file\/d\/([A-Za-z0-9_-]+)/);
    const id = fromPath?.[1] || url.searchParams.get("id");
    if (id) return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
  }
  if (url.hostname === "www.dropbox.com" || url.hostname === "dropbox.com") {
    url.searchParams.set("dl", "1");
    return url.toString();
  }
  return text;
}

/**
 * The CSV export of a Google Sheets link, keeping the tab it pointed at.
 * Returns null for a link that is not a Google Sheet.
 */
export function toSheetCsvUrl(link) {
  let url;
  try {
    url = new URL(String(link || "").trim());
  } catch {
    return null;
  }
  if (url.hostname !== "docs.google.com") return null;

  // "Publish to web" links: /spreadsheets/d/e/<key>/pub?...
  const published = url.pathname.match(/^\/spreadsheets\/d\/e\/([A-Za-z0-9_-]+)/);
  if (published) {
    const csv = new URL(`https://docs.google.com/spreadsheets/d/e/${published[1]}/pub`);
    csv.searchParams.set("output", "csv");
    const gid = url.searchParams.get("gid");
    if (gid) csv.searchParams.set("gid", gid);
    return csv.toString();
  }

  const shared = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!shared) return null;
  const csv = new URL(`https://docs.google.com/spreadsheets/d/${shared[1]}/export`);
  csv.searchParams.set("format", "csv");
  const gid = url.searchParams.get("gid") || url.hash.match(/gid=(\d+)/)?.[1];
  if (gid) csv.searchParams.set("gid", gid);
  return csv.toString();
}

/** Google's own hosts, which a sheet export redirects between. */
export function isGoogleHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "docs.google.com"
    || host.endsWith(".googleusercontent.com")
    || host === "accounts.google.com";
}
