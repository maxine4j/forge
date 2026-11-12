import assert from "node:assert/strict";
assert.equal(process.env.DOCKER_HOST, "unix:///run/forge/docker.sock");
assert.equal(process.env.GITHUB_TOKEN, undefined);
assert.equal(process.env.GH_TOKEN, undefined);
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.HOME, `${process.cwd()}/home`);
process.stdout.write("x".repeat(11 * 1024 * 1024) + "\n");
process.stdout.write('{"jobID":"test","matrix":{},"stepID":["0"],"stage":"Main","stepResult":"success"}\n');
