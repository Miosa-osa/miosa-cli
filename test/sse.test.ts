import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseSse } from "../src/client.js";
import type { Dispatcher } from "undici";
import type { SseEvent } from "../src/types.js";

/**
 * Feed exact byte chunks through the parser. The chunk split is the whole point
 * of these cases: the server writes each frame with one `Plug.Conn.chunk/2`
 * call, but a TLS record boundary or a reverse proxy can split it anywhere, and
 * the parser used to reset its per-frame state at every chunk boundary.
 */
async function events(chunks: readonly string[]): Promise<SseEvent[]> {
  const body = Readable.from(
    chunks.map((chunk) => Buffer.from(chunk, "utf8")),
  ) as unknown as Dispatcher.ResponseData["body"];
  const out: SseEvent[] = [];
  for await (const event of parseSse(body)) out.push(event);
  return out;
}

describe("parseSse frame assembly", () => {
  it("keeps the event name of a frame with no dedicated variant", async () => {
    // The server's template build stream sends `event: build_event`. Discarding
    // the name left every frame indistinguishable from every other.
    expect(
      await events(['event: build_event\ndata: {"state":"building"}\n\n']),
    ).toEqual([
      {
        type: "unknown",
        event: "build_event",
        raw: '{"state":"building"}',
      },
    ]);
  });

  it("delivers a frame whose terminating blank line lands in the next chunk", async () => {
    expect(
      await events(['event: build_event\ndata: {"state":"building"}\n', "\n"]),
    ).toEqual([
      { type: "unknown", event: "build_event", raw: '{"state":"building"}' },
    ]);
  });

  it("keeps the event name when the name and the data arrive in separate chunks", async () => {
    expect(
      await events(["event: stdout\n", 'data: {"data":"hello"}\n\n']),
    ).toEqual([{ type: "stdout", data: "hello" }]);
  });

  it("does not drop a mapped event split before its blank line", async () => {
    expect(
      await events(['event: stdout\ndata: {"data":"hello"}\n', "\n"]),
    ).toEqual([{ type: "stdout", data: "hello" }]);
  });

  it("reassembles a data payload split mid-JSON", async () => {
    expect(
      await events(['event: stdout\ndata: {"data":"hel', 'lo"}\n\n']),
    ).toEqual([{ type: "stdout", data: "hello" }]);
  });

  it("delivers a final frame the server never terminated with a blank line", async () => {
    expect(await events(['event: stdout\ndata: {"data":"last"}\n'])).toEqual([
      { type: "stdout", data: "last" },
    ]);
  });

  it("handles several frames in one chunk", async () => {
    expect(
      await events([
        'event: stdout\ndata: {"data":"one"}\n\nevent: stdout\ndata: {"data":"two"}\n\nevent: exit\ndata: {"exit_code":0}\n\n',
      ]),
    ).toEqual([
      { type: "stdout", data: "one" },
      { type: "stdout", data: "two" },
      { type: "exit", exit_code: 0 },
    ]);
  });

  it("accepts CRLF line terminators", async () => {
    expect(
      await events(['event: stdout\r\ndata: {"data":"crlf"}\r\n\r\n']),
    ).toEqual([{ type: "stdout", data: "crlf" }]);
  });

  it("ignores the server's ':heartbeat' comment frame", async () => {
    expect(
      await events([":heartbeat\n\n", 'event: stdout\ndata: {"data":"x"}\n\n']),
    ).toEqual([{ type: "stdout", data: "x" }]);
  });

  it("joins multi-line data with newlines and strips exactly one leading space", async () => {
    expect(await events(["data: line one\ndata:  line two\n\n"])).toEqual([
      { type: "unknown", raw: "line one\n line two" },
    ]);
  });

  it("does not corrupt a multi-byte character split across chunks", async () => {
    const frame = Buffer.from(
      'event: stdout\ndata: {"data":"héllo"}\n\n',
      "utf8",
    );
    // Split inside the two-byte UTF-8 sequence for "é".
    const boundary = frame.indexOf(Buffer.from("é", "utf8")) + 1;
    const body = Readable.from([
      frame.subarray(0, boundary),
      frame.subarray(boundary),
    ]) as unknown as Dispatcher.ResponseData["body"];

    const out: SseEvent[] = [];
    for await (const event of parseSse(body)) out.push(event);

    expect(out).toEqual([{ type: "stdout", data: "héllo" }]);
  });

  it("falls back to the payload's own type field when there is no event: line", async () => {
    expect(await events(['data: {"type":"stderr","data":"oops"}\n\n'])).toEqual(
      [{ type: "stderr", data: "oops" }],
    );
  });

  it("reports unparseable data as unknown while keeping the event name", async () => {
    expect(await events(["event: weird\ndata: not-json\n\n"])).toEqual([
      { type: "unknown", event: "weird", raw: "not-json" },
    ]);
  });
});
