import { describe, it, expect } from "vitest";
import { httpStatus, etagOf } from "../src/prs";

// Sample `gh api --include` outputs (headers + body), abbreviated.
const RESP_200 = `HTTP/2.0 200 OK\r\nCache-Control: private\r\nETag: W/"abc123"\r\nContent-Type: application/json\r\n\r\n{"number":10}`;
const RESP_304 = `HTTP/2.0 304 Not Modified\r\nETag: W/"abc123"\r\nCache-Control: private, max-age=60\r\n`;
const RESP_404 = `HTTP/2.0 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"message":"Not Found"}`;

describe("httpStatus", () => {
  it("reads the status line", () => {
    expect(httpStatus(RESP_200)).toBe(200);
    expect(httpStatus(RESP_304)).toBe(304);
    expect(httpStatus(RESP_404)).toBe(404);
  });
  it("returns 0 when there is no status line", () => {
    expect(httpStatus("not an http response")).toBe(0);
    expect(httpStatus("")).toBe(0);
  });
});

describe("etagOf", () => {
  it("extracts the ETag header (case-insensitive), trimming the value", () => {
    expect(etagOf(RESP_200)).toBe('W/"abc123"');
    expect(etagOf(RESP_304)).toBe('W/"abc123"');
    expect(etagOf('http/2 200 ok\r\netag:   "xyz"  \r\n')).toBe('"xyz"');
  });
  it("returns undefined when no ETag is present", () => {
    expect(etagOf(RESP_404)).toBeUndefined();
    expect(etagOf("")).toBeUndefined();
  });
});
