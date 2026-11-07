import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store.js";
import {
  identityProposal,
  confirmIdentity,
} from "../server/unified-identity.js";

test("profile attestations bind only the scoped member game profile attribute", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "identity-attribute-"));
  const db = new Store(":memory:");
  try {
    const tokenFile = join(directory, "token.json");
    await writeFile(tokenFile, JSON.stringify("test-token".repeat(4)), {
      mode: 0o600,
    });
    const school = {
      emailDomains: ["school.test"],
      identity: {
        endpoint: "http://127.0.0.1:1/",
        tokenFile,
        verifier: "skin",
        club: "school",
      },
    };
    const account = {
      id: "a".repeat(32),
      name: "Player",
      email: "player@school.test",
      school: "school",
      password: "unused",
      verified_at: 1,
    };
    db.confirm(account.email, db.challenge(account, 1), 1);
    const member = "member",
      holder = "device",
      gameProfile = account.id;
    const checkpoint = { genesis: "genesis", head: "head", sequence: 1 };
    const expected = {
      type: "bind_attribute",
      member,
      club: "school",
      kind: "game_profile",
      value: gameProfile,
    };
    const proposal = {
      genesis: checkpoint.genesis,
      previous: checkpoint.head,
      sequence: 2,
      action: expected,
      signatures: [] as unknown[],
    };
    const confirmed: unknown[] = [];
    t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer " + "test-token".repeat(4),
      );
      switch (url.pathname) {
        case "/state":
          return Response.json({
            checkpoint,
            devices: { [holder]: member },
            revoked_devices: [],
            memberships: [[member, "school"]],
            revoked_memberships: [],
          });
        case "/draft":
          assert.deepEqual(JSON.parse(String(init.body)), expected);
          return Response.json(proposal);
        case "/confirm":
          confirmed.push(JSON.parse(String(init.body)));
          return Response.json(checkpoint);
        default:
          assert.fail("Unexpected bridge operation");
      }
    });
    assert.deepEqual(
      await identityProposal(db, account, holder, school, true, gameProfile),
      proposal,
    );
    const signed = {
      ...proposal,
      signatures: [{ public_key: [], signature: [] }],
    };
    for (const action of [
      { ...expected, type: "bind_game_profile", profile: gameProfile },
      { ...expected, kind: "other_attribute" },
      { ...expected, value: "b".repeat(32) },
      { ...expected, member: "other-member" },
      { ...expected, club: "other-club" },
    ]) {
      await assert.rejects(
        confirmIdentity(
          db,
          account,
          school,
          { ...signed, action },
          gameProfile,
        ),
        /Unsupported identity attestation|Account identity scope mismatch/,
      );
    }
    await assert.rejects(
      confirmIdentity(db, account, school, proposal, gameProfile),
      /Device possession signature required/,
    );
    assert.deepEqual(confirmed, []);
    assert.deepEqual(
      await confirmIdentity(db, account, school, signed, gameProfile),
      { member, checkpoint },
    );
    assert.deepEqual(confirmed, [signed]);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
