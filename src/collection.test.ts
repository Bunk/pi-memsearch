import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { deriveCollection } from "./collection";

const MILVUS_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

test("deriveCollection produces the ms_<basename>_<8hex> shape", () => {
	const name = deriveCollection("/Users/jd/bunk/pi-memsearch");
	const expectedHash = createHash("sha256").update(resolve("/Users/jd/bunk/pi-memsearch")).digest("hex").slice(0, 8);
	assert.equal(name, `ms_pi_memsearch_${expectedHash}`);
});

test("deriveCollection is deterministic for the same cwd", () => {
	assert.equal(deriveCollection("/tmp/proj-x"), deriveCollection("/tmp/proj-x"));
});

test("deriveCollection differs for different cwds", () => {
	assert.notEqual(deriveCollection("/tmp/proj-a"), deriveCollection("/tmp/proj-b"));
});

test("deriveCollection sanitizes uppercase, spaces, and special chars", () => {
	const name = deriveCollection("/tmp/My Cool App!!");
	assert.ok(name.startsWith("ms_my_cool_app_"), name);
	assert.ok(MILVUS_NAME.test(name), `not a valid Milvus name: ${name}`);
});

test("deriveCollection collapses and trims underscores", () => {
	const name = deriveCollection("/tmp/--weird--name--");
	assert.ok(name.startsWith("ms_weird_name_"), name);
});

test("deriveCollection truncates the sanitized basename to 40 chars", () => {
	const name = deriveCollection(`/tmp/${"a".repeat(80)}`);
	const body = name.slice("ms_".length, name.lastIndexOf("_"));
	assert.equal(body.length, 40);
});

test("deriveCollection yields a Milvus-valid name even for a degenerate basename", () => {
	const name = deriveCollection("/");
	assert.ok(MILVUS_NAME.test(name), `not a valid Milvus name: ${name}`);
	assert.ok(name.length <= 255);
});
