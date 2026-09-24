import { describe, expect, it } from "vitest";
import { decideRequestGate, type GateCopy, type GateViewer } from "./request-gate";

const copy: GateCopy = {
  id: "c1",
  ownerId: "owner",
  clusterId: "cl1",
  availability: "available",
  minBorrowerTrust: 0,
};
const active: GateViewer = {
  signedIn: true,
  onboarded: true,
  memberId: "m1",
  clusterId: "cl1",
  trustScore: 60,
  state: "active",
};
const FLOOR = 30;

describe("decideRequestGate", () => {
  it("signed-out viewers get a sign-in link", () => {
    expect(
      decideRequestGate({ ...active, signedIn: false, memberId: null, state: null }, copy, FLOOR),
    ).toEqual({ kind: "sign_in" });
  });

  it("copies on loan are blocked for everyone", () => {
    expect(decideRequestGate(active, { ...copy, availability: "on_loan" }, FLOOR)).toMatchObject({
      kind: "blocked",
      reason: "on_loan",
    });
  });

  it("owners cannot request their own copy", () => {
    expect(decideRequestGate({ ...active, memberId: "owner" }, copy, FLOOR)).toMatchObject({
      kind: "blocked",
      reason: "own_copy",
    });
  });

  it("other-cluster members are blocked", () => {
    expect(decideRequestGate({ ...active, clusterId: "cl2" }, copy, FLOOR)).toMatchObject({
      kind: "blocked",
      reason: "other_cluster",
    });
  });

  it("hides the CTA below the copy's minimum trust, but shows a hint below the global floor", () => {
    expect(
      decideRequestGate({ ...active, trustScore: 45 }, { ...copy, minBorrowerTrust: 50 }, FLOOR),
    ).toEqual({ kind: "hidden" });
    expect(decideRequestGate({ ...active, trustScore: 25 }, copy, FLOOR)).toMatchObject({
      kind: "blocked",
      reason: "trust_floor",
    });
    expect(
      decideRequestGate({ ...active, trustScore: 50 }, { ...copy, minBorrowerTrust: 50 }, FLOOR),
    ).toEqual({ kind: "request" });
  });

  it("routes non-active members to the right hint", () => {
    expect(decideRequestGate({ ...active, state: "registered" }, copy, FLOOR)).toMatchObject({
      reason: "needs_activation",
    });
    expect(decideRequestGate({ ...active, state: "lapsed" }, copy, FLOOR)).toMatchObject({
      reason: "lapsed",
    });
    expect(decideRequestGate({ ...active, state: "suspended" }, copy, FLOOR)).toMatchObject({
      reason: "suspended",
    });
    expect(decideRequestGate({ ...active, onboarded: false }, copy, FLOOR)).toEqual({
      kind: "onboard",
    });
  });

  it("active members in the cluster with enough trust may request", () => {
    expect(decideRequestGate(active, copy, FLOOR)).toEqual({ kind: "request" });
  });
});
