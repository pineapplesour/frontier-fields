import React, { useEffect, useState } from "react";
import { RESOURCES, TYPES } from "../shared/rules.js";
import { Icon, UnitIcon } from "./Icons.jsx";
import { factionFor } from "./factions.js";
import { cityFoodSummary, detailedLogisticsState } from "./logisticsHelpers.js";
const empty = () => ({
  gold: 0,
  food: 0,
  foodCityId: null,
  foodDestinationCityId: null,
  resources: {},
  units: [],
  cities: [],
  warAgainst: null,
  openBorders: false,
});
export function dealItems(side, labels = {}, game = null) {
  return [
    ...(side.gold ? [`${side.gold}G`] : []),
    ...(side.openBorders ? ["국경개방 30턴"] : []),
    ...(side.food ? [`식량 ${side.food}`] : []),
    ...Object.entries(side.resources)
      .filter(([, n]) => n)
      .map(([r, n]) => `${RESOURCES[r].name} ${n}`),
    ...side.units.map((id) => labels[id] ?? "유닛"),
    ...side.cities.map((id) => labels[id] ?? "도시"),
    ...(side.warAgainst
      ? [`${factionFor(game, side.warAgainst).name} 전쟁 참전`]
      : []),
  ];
}
export function DealSummary({ proposal, game = null }) {
  return (
    <div className="deal-summary">
      <div>
        <small>{factionFor(game, proposal.from).name} 제공</small>
        <p>{dealItems(proposal.give, proposal.labels, game).join(" · ") || "없음"}</p>
      </div>
      <div>
        <small>{factionFor(game, proposal.to).name} 제공</small>
        <p>
          {dealItems(proposal.receive, proposal.labels, game).join(" · ") || "없음"}
        </p>
      </div>
      {proposal.alliance ? <strong>양측 10턴 동맹</strong> : null}
      {proposal.peace ? (
        <strong>평화 협정 · 전쟁 종료 / 5턴 재선포 금지</strong>
      ) : null}
    </div>
  );
}
export function DealBuilder({ game, faction, disabled, onTrade, onPreview }) {
  const [give, setGive] = useState(empty),
    [receive, setReceive] = useState(empty),
    [alliance, setAlliance] = useState(false),
    [review, setReview] = useState(false);
  const [peace, setPeace] = useState(!!faction.hostile),
    [category, setCategory] = useState({ mine: "goods", theirs: "goods" }),
    [quote, setQuote] = useState(null);
  const detailedSupply = detailedLogisticsState(game).enabled;
  const foodCities = (owner) =>
    game.cities.filter((city) => city.owner === owner && !city.camp);
  const termsKey = JSON.stringify({
    give,
    receive,
    alliance,
    peace,
    detailedSupply,
    factionId: faction.id,
    revision: game.revision,
  });
  const currentQuote = quote?.key === termsKey ? quote : null;
  const foodBlocked = !detailedSupply && (give.food > 0 || receive.food > 0);
  useEffect(() => {
    if (disabled || foodBlocked) {
      setQuote(null);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const result = await onPreview(
          { factionId: faction.id, give, receive, alliance, peace },
          controller.signal,
        );
        if (!controller.signal.aborted) setQuote({ ...result, key: termsKey });
      } catch (error) {
        if (!controller.signal.aborted)
          setQuote({
            key: termsKey,
            status: "unavailable",
            message: "거래 조건을 확인하지 못했어요. 연결을 확인해 주세요.",
          });
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [disabled, foodBlocked, onPreview, termsKey]);
  const labels = Object.fromEntries(
    [...game.units, ...game.cities].map((e) => [
      e.id,
      e.name ?? `${TYPES[e.type].name} ×${e.size}`,
    ]),
  );
  const edit = (mine, fn) => {
    (mine ? setGive : setReceive)(fn);
    setReview(false);
  };
  const changeAmount = (mine, key, delta) =>
    edit(mine, (s) =>
      key === "gold"
        ? {
            ...s,
            gold: Math.max(
              0,
              Math.min(mine ? game.economy.gold : 10000, s.gold + delta),
            ),
          }
        : {
            ...s,
            resources: {
              ...s.resources,
              [key]: Math.max(
                0,
                Math.min(
                  mine ? game.economy.resources[key] : 100,
                  (s.resources[key] ?? 0) + delta,
                ),
              ),
            },
          },
    );
  const changeFood = (mine, delta) =>
    edit(mine, (s) => {
      const owner = mine ? game.playerId : faction.id;
      const recipient = mine ? faction.id : game.playerId;
      const sourceCities = foodCities(owner);
      const destinationCities = foodCities(recipient);
      const sourceId = s.foodCityId ?? sourceCities[0]?.id ?? null;
      const destinationId =
        s.foodDestinationCityId ?? destinationCities[0]?.id ?? null;
      const source = sourceCities.find((city) => city.id === sourceId);
      const sourceFood = source ? cityFoodSummary(source, game) : null;
      const maximum = mine
        ? sourceFood?.stockAvailable
          ? Math.max(0, Math.min(100, sourceFood.stored))
          : 0
        : 100;
      return {
        ...s,
        foodCityId: sourceId,
        foodDestinationCityId: destinationId,
        food: Math.max(0, Math.min(maximum, (s.food ?? 0) + delta)),
      };
    });
  const changeFoodCity = (mine, field, value) =>
    edit(mine, (s) => ({
      ...s,
      [field]: value || null,
      ...(field === "foodCityId" ? { food: 0 } : {}),
    }));
  const toggle = (mine, kind, id) =>
    edit(mine, (s) =>
      kind === "warAgainst"
        ? { ...s, warAgainst: s.warAgainst === id ? null : id }
        : {
            ...s,
            [kind]: s[kind].includes(id)
              ? s[kind].filter((x) => x !== id)
              : [...s[kind], id],
          },
    );
  const pending = game.diplomacy.some(
    (p) => p.from === faction.id || p.to === faction.id,
  );
  const renderSide = (mine) => {
    const owner = mine ? game.playerId : faction.id,
      s = mine ? give : receive,
      items = dealItems(s, labels, game);
    const cities = game.cities.filter((c) => c.owner === owner),
      units = game.units.filter(
        (u) => u.owner === owner && !TYPES[u.type]?.internal,
      );
    const sourceCities = foodCities(owner),
      destinationCities = foodCities(mine ? faction.id : game.playerId),
      selectedSourceCityId =
        s.foodCityId ?? sourceCities[0]?.id ?? "",
      selectedDestinationCityId =
        s.foodDestinationCityId ?? destinationCities[0]?.id ?? "",
      sourceCity = sourceCities.find((city) => city.id === selectedSourceCityId),
      sourceFood = sourceCity ? cityFoodSummary(sourceCity, game) : null,
      ownFoodUnavailable = mine && !sourceFood?.stockAvailable;
    const sideKey = mine ? "mine" : "theirs",
      selectedCategory = category[sideKey];
    return (
      <section
        className="deal-side"
        style={{ "--faction": factionFor(game, owner).color }}
      >
        <header>
          <span className="faction-emblem">{factionFor(game, owner).symbol}</span>
          <div>
            <h3>{mine ? "내가 주는 것" : "상대가 주는 것"}</h3>
            <small>{factionFor(game, owner).name}</small>
          </div>
        </header>
        <nav
          className="deal-category-tabs"
          aria-label={mine ? "내 거래 목록 분류" : "상대 거래 목록 분류"}
        >
          {Object.entries({
            goods: "골드·자원",
            assets: "도시·유닛",
            war: "국경·참전",
          }).map(([id, name]) => (
            <button
              key={id}
              aria-pressed={selectedCategory === id}
              disabled={disabled}
              onClick={() => setCategory((c) => ({ ...c, [sideKey]: id }))}
            >
              {name}
            </button>
          ))}
        </nav>
        <div
          className={`offer-shelf ${items.length ? "filled" : ""}`}
          aria-label={mine ? "내 제안 항목" : "상대 제안 항목"}
        >
          {!items.length ? <p>아래 카드를 눌러 제안에 추가</p> : null}
          {s.gold > 0 ? (
            <div className="offer-chip">
              <span>골드</span>
              <button
                aria-label={`${mine ? "내" : "상대"} 골드 10 빼기`}
                disabled={disabled}
                onClick={() => changeAmount(mine, "gold", -10)}
              >
                −
              </button>
              <b>{s.gold}G</b>
              <button
                aria-label={`${mine ? "내" : "상대"} 골드 10 더하기`}
                disabled={
                  disabled || (mine && game.economy.gold <= s.gold)
                }
                onClick={() => changeAmount(mine, "gold", 10)}
              >
                +
              </button>
            </div>
          ) : null}
          {Object.entries(s.resources)
            .filter(([, n]) => n)
            .map(([r, n]) => (
              <div className="offer-chip" key={r}>
                <Icon name={RESOURCES[r].icon} size={13} />
                <span>{RESOURCES[r].name}</span>
                <button
                  aria-label={`${mine ? "내" : "상대"} ${RESOURCES[r].name} 빼기`}
                  disabled={disabled}
                  onClick={() => changeAmount(mine, r, -1)}
                >
                  −
                </button>
                <b>{n}</b>
                <button
                  aria-label={`${mine ? "내" : "상대"} ${RESOURCES[r].name} 더하기`}
                  disabled={
                    disabled ||
                    (mine &&
                      (game.economy.resources[r] ?? 0) <=
                        (s.resources[r] ?? 0))
                  }
                  onClick={() => changeAmount(mine, r, 1)}
                >
                  +
                </button>
              </div>
            ))}
          {s.food > 0 ? (
            <div className="offer-chip">
              <Icon name="wheat" size={13} />
              <span>식량</span>
              <button
                aria-label={`${mine ? "내" : "상대"} 식량 1 빼기`}
                disabled={disabled}
                onClick={() => changeFood(mine, -1)}
              >
                −
              </button>
              <b>{s.food}</b>
              <button
                aria-label={`${mine ? "내" : "상대"} 식량 1 더하기`}
                disabled={disabled || (mine && ownFoodUnavailable)}
                onClick={() => changeFood(mine, 1)}
              >
                +
              </button>
            </div>
          ) : null}
          {["cities", "units"].flatMap((kind) =>
            s[kind].map((id) => (
              <button
                className="offer-chip removable"
                key={id}
                disabled={disabled}
                onClick={() => toggle(mine, kind, id)}
              >
                {labels[id]}
                <Icon name="close" size={12} />
              </button>
            )),
          )}
          {s.openBorders ? <button className="offer-chip removable" disabled={disabled}
            onClick={() => edit(mine, side => ({ ...side, openBorders: false }))}>
            국경개방 30턴<Icon name="close" size={12} />
          </button> : null}
          {s.warAgainst ? (
            <button
              className="offer-chip war-term removable"
              disabled={disabled}
              onClick={() => toggle(mine, "warAgainst", s.warAgainst)}
            >
              {factionFor(game, s.warAgainst).name} 참전
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </div>
        <div className="deal-inventory-scroll">
          <div hidden={selectedCategory !== "goods"}>
            <h4>거래 가능 · 골드와 자원</h4>
            <div className="trade-inventory">
              <button
                className="asset-card"
                onClick={() => changeAmount(mine, "gold", 10)}
                disabled={
                  disabled || (mine && game.economy.gold <= s.gold)
                }
              >
                <strong>G</strong>
                <span>
                  골드
                  <small>
                    {mine ? `${game.economy.gold} 보유` : "10G씩 요청"}
                  </small>
                </span>
                <b>+</b>
              </button>
              {Object.entries(RESOURCES).map(([r, d]) => (
                <button
                  className="asset-card"
                  key={r}
                  onClick={() => changeAmount(mine, r, 1)}
                  disabled={
                    disabled ||
                    (mine &&
                      (game.economy.resources[r] ?? 0) <=
                        (s.resources[r] ?? 0))
                  }
                >
                  <Icon name={d.icon} size={18} />
                  <span>
                    {d.name}
                    <small>
                      {mine
                        ? `${game.economy.resources[r]} 보유`
                        : "보유량 비공개"}
                    </small>
                  </span>
                  <b>+</b>
                </button>
              ))}
            </div>
            {detailedSupply ? (
              <div className="trade-food-card">
                <header>
                  <span>
                    <Icon name="wheat" size={17} />
                    <strong>물리 식량</strong>
                  </span>
                  <small>도시에서 도시로 배송</small>
                </header>
                <div className="trade-food-fields">
                  <label>
                    출발 도시
                    <select
                      value={selectedSourceCityId}
                      disabled={disabled || !sourceCities.length}
                      onChange={(event) =>
                        changeFoodCity(mine, "foodCityId", event.target.value)
                      }
                    >
                      {!sourceCities.length ? <option value="">확인된 도시 없음</option> : null}
                      {sourceCities.map((city) => (
                        <option key={city.id} value={city.id}>{city.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    도착 도시
                    <select
                      value={selectedDestinationCityId}
                      disabled={disabled || !destinationCities.length}
                      onChange={(event) =>
                        changeFoodCity(
                          mine,
                          "foodDestinationCityId",
                          event.target.value,
                        )
                      }
                    >
                      {!destinationCities.length ? <option value="">확인된 도시 없음</option> : null}
                      {destinationCities.map((city) => (
                        <option key={city.id} value={city.id}>{city.name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="trade-food-amount">
                  <span>
                    요청 수량
                    <small>
                      {mine
                        ? sourceFood?.stockAvailable
                          ? `${sourceFood.stored} 저장됨`
                          : "출발 도시의 저장량을 확인할 수 없음"
                        : "상대 도시의 보유량은 수락 시 확인"}
                    </small>
                  </span>
                  <button
                    type="button"
                    aria-label={`${mine ? "내" : "상대"} 식량 1 빼기`}
                    disabled={disabled || s.food <= 0}
                    onClick={() => changeFood(mine, -1)}
                  >−</button>
                  <b>{s.food}</b>
                  <button
                    type="button"
                    aria-label={`${mine ? "내" : "상대"} 식량 1 더하기`}
                    disabled={
                      disabled ||
                      !sourceCities.length ||
                      !destinationCities.length ||
                      (mine && ownFoodUnavailable)
                    }
                    onClick={() => changeFood(mine, 1)}
                  >+</button>
                </div>
                {mine && ownFoodUnavailable ? (
                  <p className="trade-food-note">
                    출발 도시의 공개된 비축량이 없어 식량을 제안할 수 없어요.
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="trade-food-note">
                식량 거래는 상세 보급 ON에서 가능해요. OFF 성장 진척은 거래·수송하지 않아요.
              </p>
            )}
          </div>
          <div hidden={selectedCategory !== "assets"}>
            <h4>거래 가능 · 도시와 유닛</h4>
            <div className="trade-inventory entity-inventory">
              {cities.map((c) => (
                <button
                  key={c.id}
                  className={`asset-card ${s.cities.includes(c.id) ? "chosen" : ""}`}
                  disabled={disabled}
                  onClick={() => toggle(mine, "cities", c.id)}
                >
                  <Icon name="city" size={18} />
                  <span>
                    {c.name}
                    <small>
                      {c.capital ? "수도 · 소유권 이전" : "도시 · 영토 포함"}
                    </small>
                  </span>
                  <Icon
                    name={s.cities.includes(c.id) ? "check" : "plus"}
                    size={13}
                  />
                </button>
              ))}
              {units.map((u) => (
                <button
                  key={u.id}
                  className={`asset-card ${s.units.includes(u.id) ? "chosen" : ""}`}
                  disabled={disabled}
                  onClick={() => toggle(mine, "units", u.id)}
                >
                  <UnitIcon type={u.type} size={18} />
                  <span>
                    {TYPES[u.type].name}
                    <small>
                      ×{u.size} · 체력 {u.hp}
                    </small>
                  </span>
                  <Icon
                    name={s.units.includes(u.id) ? "check" : "plus"}
                    size={13}
                  />
                </button>
              ))}
              {!units.length && !cities.length ? (
                <p className="inventory-empty">현재 확인한 자산이 없어요.</p>
              ) : null}
            </div>
          </div>
          <div hidden={selectedCategory !== "war"}>
            <button className={`asset-card ${s.openBorders ? "chosen" : ""}`}
              aria-pressed={s.openBorders} disabled={disabled}
              onClick={() => edit(mine, side => ({ ...side, openBorders: !side.openBorders }))}>
              <Icon name="flag" />
              <span>국경개방 30턴<small>{mine ? "상대가 내 영토에 진입" : "내가 상대 영토에 진입"} · 수락 시 시작</small></span>
              <Icon name={s.openBorders ? "check" : "plus"} />
            </button>
            <h4>제3문명 참전 조건</h4>
            <div className="war-inventory">
              {game.factions
                .filter(
                  (f) =>
                    ![
                      owner,
                      mine ? faction.id : game.playerId,
                      "barb",
                    ].includes(f.id),
                )
                .map((f) => {
                  const already = (game.conflicts ?? []).some(
                    (pair) => pair.includes(owner) && pair.includes(f.id),
                  );
                  return (
                    <button
                      key={f.id}
                      className={`asset-card ${s.warAgainst === f.id ? "chosen" : ""}`}
                      disabled={disabled || already}
                      onClick={() => toggle(mine, "warAgainst", f.id)}
                    >
                      <i style={{ background: f.color }} />
                      <span>
                        {f.name}
                        <small>
                          {already ? "이미 참전 중" : "이 문명과의 전쟁에 참여"}
                        </small>
                      </span>
                      <Icon
                        name={s.warAgainst === f.id ? "check" : "plus"}
                        size={13}
                      />
                    </button>
                  );
                })}
            </div>
          </div>
        </div>
      </section>
    );
  };
  const proposal = {
    from: game.playerId,
    to: faction.id,
    give,
    receive,
    alliance,
    peace,
    labels,
  };
  return (
    <div className="deal-builder">
        <p className="description">
        양쪽 목록에서 제안에 담고, 위의 항목을 눌러 빼세요. 조건에 대한 상대의
        반응이 바로 표시돼요.
      </p>
      <div className="deal-columns">
        {renderSide(true)}
        {renderSide(false)}
      </div>
      <div className="treaty-options">
        <button
          className={`alliance-term ${peace ? "chosen" : ""}`}
          aria-pressed={peace}
          disabled={disabled || (!peace && (faction.peaceLockedUntil ?? 0) > game.turn)}
          onClick={() => {
            setPeace(!peace);
            setReview(false);
          }}
        >
          <Icon name="flag" size={18} />
          <span>
            평화 협정<small>{(faction.peaceLockedUntil ?? 0) > game.turn ? `개전 후 평화 금지 · ${faction.peaceLockedUntil - game.turn}턴 남음` : "전쟁 종료 · 5턴 재선포 금지"}</small>
          </span>
          <Icon name={peace ? "check" : "plus"} size={16} />
        </button>
        <button
          className={`alliance-term ${alliance ? "chosen" : ""}`}
          disabled={disabled || (!alliance && (faction.denouncementUntil ?? 0) > game.turn)}
          onClick={() => {
            setAlliance(!alliance);
            setReview(false);
          }}
          aria-pressed={alliance}
        >
          <Icon name="link" size={18} />
          <span>
            양측 동맹 · 10턴
            <small>{(faction.denouncementUntil ?? 0) > game.turn ? "공개비난 중 동맹 불가" : "공격·방어 전쟁 공동 참전 · 10턴 갱신 · 시야 공유 없음"}</small>
          </span>
          <Icon name={alliance ? "check" : "plus"} size={16} />
        </button>
      </div>
      <div
        className={`negotiation-status ${currentQuote?.status ?? "loading"}`}
        role="status"
        aria-live="polite"
      >
        <span
          className="faction-emblem"
          style={{ "--faction": faction.color, background: faction.color }}
        >
          {faction.symbol}
        </span>
        <div>
          <strong>
            {currentQuote?.status === "accept"
              ? "이 조건이라면 좋습니다."
              : currentQuote?.status === "human"
                ? "상대의 직접 수락이 필요해요."
                : currentQuote?.status === "insufficient"
                  ? "대가를 더 제시해 주십시오."
                  : currentQuote?.never
                    ? "이 조건으로는 절대 수락하지 않아요."
                    : "협상 조건"}
          </strong>
          <p>{currentQuote?.message ?? "조건을 확인하고 있어요…"}</p>
          {currentQuote && currentQuote.wouldAccept !== null && currentQuote.wouldAccept !== undefined ? (
            <p
              className={`npc-verdict ${currentQuote.wouldAccept ? "yes" : "no"}`}
              data-testid="npc-verdict"
            >
              {currentQuote.wouldAccept
                ? "지금 제안하면 바로 수락해요."
                : currentQuote.never
                  ? `절대 수락하지 않아요 · ${currentQuote.reason ?? ""}`
                  : currentQuote.reason ?? "지금은 수락하지 않아요."}
            </p>
          ) : null}
        </div>
        {(() => {
          const demands = currentQuote?.demands;
          const gold = demands?.gold ?? 0;
          const resourceList = Object.entries(demands?.resources ?? {}).filter(([, n]) => n > 0);
          const canFillGold = gold > 0 && currentQuote.canAfford;
          const canFillResources = resourceList.length > 0 && !canFillGold;
          const fillable = canFillGold || canFillResources;
          return (
            <button
              className="soft-button"
              data-testid="auto-fill-demands"
              disabled={disabled || !fillable}
              data-tip="상대가 지금 수락하는 데 필요한 골드(부족하면 동등 가치의 자원)를 현재 제안에 자동으로 채워요. 사람 상대의 수락은 예측하지 않아요."
              onClick={() => {
                setGive((s) =>
                  canFillGold
                    ? { ...s, gold: s.gold + gold }
                    : {
                        ...s,
                        resources: Object.fromEntries(
                          [...new Set([...Object.keys(s.resources), ...resourceList.map(([r]) => r)])].map((r) => [
                            r,
                            (s.resources[r] ?? 0) + (demands.resources[r] ?? 0),
                          ]),
                        ),
                      },
                );
                setReview(false);
              }}
            >
              상대 요구 조건 자동 채우기
              <small>
                {canFillGold
                  ? `골드 +${gold} 반영`
                  : canFillResources
                    ? `자원 ${resourceList.map(([r, n]) => `${RESOURCES[r].name} +${n}`).join(" · ")} 반영`
                    : gold > 0
                      ? `골드 +${gold} · 보유량 부족`
                      : "추가 조건 없음"}
              </small>
            </button>
          );
        })()}
      </div>
      {review ? (
        <div className="deal-review">
          <h3>이 조건으로 제안할까요?</h3>
          <DealSummary proposal={proposal} />
          {[...give.cities, ...receive.cities].some(
            (id) => game.cities.find((c) => c.id === id)?.capital,
          ) ? (
            <p className="deal-warning">
              수도 소유권 이전이 포함돼요. 승리·패배로 이어질 수 있어요.
            </p>
          ) : null}
          {give.warAgainst || receive.warAgainst ? (
            <p className="deal-warning">
              수락 즉시 표시된 문명과 전쟁 상태가 됩니다. 모든 세력에 선포가
              전달돼요.
            </p>
          ) : null}
          <p className="fine-print">
            내 골드·자원은 제안 중 보관돼요. 도시·유닛은 수락 순간 이전되며,
            소유권이 바뀌거나 파괴되면 거래할 수 없어요. 도시의 주둔군은 별도로
            포함해야 합니다.
          </p>
          {foodBlocked ? (
            <p className="deal-warning">
              상세 보급 OFF에서는 식량 거래를 저장할 수 없어요.
            </p>
          ) : null}
        </div>
      ) : null}
      <button
        className="primary full"
          disabled={
            disabled ||
            pending ||
            foodBlocked ||
            !currentQuote ||
          !["accept", "human"].includes(currentQuote.status)
        }
        onClick={async () => {
          if (!review) {
            setReview(true);
            return;
          }
          if (
            await onTrade({
              action: "offerDeal",
              factionId: faction.id,
              give,
              receive,
              alliance,
              peace,
            })
          ) {
            setGive(empty());
            setReceive(empty());
            setAlliance(false);
            setPeace(false);
            setReview(false);
          }
        }}
      >
        {pending
          ? "제안에 응답을 기다리는 중"
          : review
            ? "거래 제안 보내기"
            : "제안 검토"}
        <Icon name="arrow" size={16} />
      </button>
    </div>
  );
}
