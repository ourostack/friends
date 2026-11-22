// Friends' MCP walker (ax/walkers/mcp.mts), over fixtures shaped like actions/generated and actions/friends.actions.mts.
import assert from "node:assert/strict";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { walk } from "./mcp.mts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIX = relative(ROOT, join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp"));
const at = (file: string) => `${FIX}/${file}`;
const options = (more: Record<string, unknown> = {}) => ({ product: "friends", module: at("mcp.json"), source: at("defs.mts"), root: ROOT, ...more });

test("each served tool is a door at its defineAction id literal, with the served read-only hint as evidence", async () => {
  const { doors, errors } = await walk(options());
  assert.deepEqual(errors, []);
  assert.deepEqual(
    doors.map((d) => [d.id, d.kind, d.product, d.name, d.description, d.file, d.line, d.card, d.evidence]),
    [
      ["mcp:get_friend", "mcp", "friends", "get_friend", "Fetch a friend.", at("defs.mts"), 3, null, { readOnly: true }],
      ["mcp:save_note", "mcp", "friends", "save_note", "Save a note.", at("defs.mts"), 4, null, {}],
      // An id outside a defineAction call is not the action's declaration.
      ["mcp:whoami", "mcp", "friends", "whoami", "Say who you are.", at("defs.mts"), null, null, {}],
    ],
  );
});

test("a card is the declaration's when, consent and errors with the sidecar's group; codes count as raised in the handlers, hyphens or underscores", async () => {
  const { doors, errors } = await walk(options({ cards: at("cards.json"), handlers: [at("handlers")] }));
  assert.deepEqual(errors, []);
  const [get, save, whoami] = doors;
  assert.deepEqual(get.card, {
    id: "mcp:get_friend",
    group: "friend-records",
    when: "Reading one friend record by its uuid or name before acting on it",
    effect: "read",
    errors: [
      { code: "not-found", means: "No friend has that uuid or name.", fix: "List friends and call again with one of theirs." },
      { code: "never-raised", means: "Declared but raised nowhere.", fix: "Drop it from the card." },
    ],
  });
  // never-raised appears only inside an error card, which declares it rather than raising it.
  assert.deepEqual(get.evidence, { readOnly: true, raises: ["not-found"] });
  assert.deepEqual(save.card, {
    id: "mcp:save_note",
    group: "friend-records",
    when: "Writing a name, tool preference or note onto a friend record",
    effect: "write",
    errors: [{ code: "invalid", means: "The note type is not one the tool knows.", fix: "Pass name, tool_preference or note." }],
    destructive: true,
    idempotent: true,
  });
  assert.deepEqual(save.evidence, { raises: ["invalid"] });
  // A declaration without a when line is no card yet.
  assert.equal(whoami.card, null);
});

test("without handlers the walker can't tell what is raised, so it claims nothing either way", async () => {
  const { doors } = await walk(options({ cards: at("cards.json") }));
  assert.deepEqual(doors[0].evidence, { readOnly: true });
});

test("a declaration or group entry for a tool the server doesn't serve, and a tool in two groups, are census errors", async () => {
  const { doors, errors } = await walk(options({ cards: at("stale.json"), handlers: [at("handlers")] }));
  assert.deepEqual(errors, [
    `mcp:get_friend: in two groups in ${at("stale.json")}, friend-records and twice`,
    `mcp:gone: grouped in ${at("stale.json")}, but ${at("mcp.json")} doesn't serve it. Fix: remove it from the group, or serve the tool.`,
    `mcp:gone: declared in ${at("stale-actions.json")}, but ${at("mcp.json")} doesn't serve it. Fix: remove the declaration, or serve the tool.`,
  ]);
  assert.equal(doors[0].card?.group, "friend-records");
  // A served tool with no declaration has no card.
  assert.equal(doors[1].card, null);
});

test("a server with cards needs an unknown-door error card, raised by its handlers", async () => {
  const missing = await walk(options({ cards: at("no-server.json"), handlers: [at("handlers")] }));
  assert.deepEqual(missing.errors, [`${at("no-server.json")}: declares tool cards but no server errors with an unknown-door card, the answer to an unknown tool name`]);
  const unraised = await walk(options({ cards: at("cards.json"), handlers: [at("handlers/no-unknown.ts")] }));
  assert.deepEqual(unraised.errors, [`${at("cards.json")}: the unknown-door code is never raised in ${at("handlers/no-unknown.ts")}`]);
});

test("a tool listed twice, a tool without a name, a catalog without tools and an unreadable sidecar are census errors", async () => {
  const twice = await walk(options({ module: at("twice.json") }));
  assert.deepEqual(twice.doors.map((d) => d.id), ["mcp:a"]);
  assert.deepEqual(twice.errors, [`${at("twice.json")}: a tool without a name`, `mcp:a: listed twice in ${at("twice.json")}`]);
  const none = await walk(options({ module: at("no-tools.json") }));
  assert.deepEqual(none.errors, [`${at("no-tools.json")}: a catalog with no tools list`]);
  const broken = await walk(options({ cards: at("broken.json") }));
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0], new RegExp(`^${at("broken.json")}: can't read the cards: `));
  const brokenDecls = await walk(options({ cards: at("no-tools.json") }));
  assert.deepEqual(brokenDecls.errors, [`${at("no-tools.json")}: names no declarations file`]);
  const badDecls = await walk(options({ cards: at("bad-decls.json") }));
  assert.equal(badDecls.errors.length, 1);
  assert.match(badDecls.errors[0], new RegExp(`^${at("broken.json")}: can't read the declarations: `));
  // A declarations file with no actions list would leave every door uncarded without saying why.
  const noActions = await walk(options({ cards: at("no-actions.json") }));
  assert.deepEqual(noActions.errors, [`${at("no-tools.json")}: has no actions list`]);
});

test("an unreadable catalog is a census error, not an empty walk", async () => {
  const { doors, errors } = await walk(options({ module: at("broken.json") }));
  assert.deepEqual(doors, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(`^${at("broken.json")}: can't read the catalog: `));
});
