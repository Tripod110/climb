SELECT tick, entity_index, "m_steamID", "m_iTeamNum", "m_iszPlayerName",
  "m_PlayerDataGlobal__m_nHeroID" AS hero, "m_PlayerDataGlobal__m_iGoldNetWorth" AS nw,
  "m_PlayerDataGlobal__m_iLevel" AS lvl, "m_PlayerDataGlobal__m_iHealthMax" AS hmax, "m_nAssignedLane" AS lane
FROM CCitadelPlayerController
WHERE tick % 640 = 0 OR delta_type <> 'update'
