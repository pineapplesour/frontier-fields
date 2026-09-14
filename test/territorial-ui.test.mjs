import test from "node:test";
import assert from "node:assert/strict";
import { ultimatumDescription, ultimatumAcceptanceLabel, isTerritorialUltimatum, territorialOption } from "../src/territorialDiplomacy.js";

test("territorial notices distinguish irreversible city removal from troop withdrawal and gold", () => {
  const city = { kind: "ultimatum", demand: "removeCity", cityId: "c1", cityName: "접경 도시" };
  assert.match(ultimatumDescription(city), /접경 도시.*철거.*되돌릴 수 없고.*10턴/);
  assert.match(ultimatumAcceptanceLabel(city), /도시 철거/);
  assert.equal(isTerritorialUltimatum(city), true);
  assert.match(ultimatumDescription({ demand: "withdrawTroops" }), /주변 2칸.*철수.*10턴/);
  assert.match(ultimatumAcceptanceLabel({ demand: "withdrawTroops" }), /군대 철수/);
  assert.equal(isTerritorialUltimatum({ kind: "ultimatum", gold: 40 }), false);
  assert.equal(ultimatumAcceptanceLabel({ gold: 40 }), "40G 지급하고 수락");
});

test("candidate options use authoritative observed faction contract only", () => {
  const option = { factionId: "p2", canWithdrawTroops: false, nearbyMilitaryTurns: 2, cities: [] };
  const game = { territorialDiplomacy: { options: [option] }, cities: [{ owner: "p3" }] };
  assert.equal(territorialOption(game, "p2"), option);
  assert.equal(territorialOption(game, "p3"), null);
});
