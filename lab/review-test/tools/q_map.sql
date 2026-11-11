SELECT entity_index, max("m_PlayerDataGlobal__m_nHeroID") AS hero, max("m_iTeamNum") AS team, max("m_hHeroPawn") AS hp,
  max("m_iszPlayerName") AS name, max("m_steamID") AS steam
FROM CCitadelPlayerController WHERE "m_PlayerDataGlobal__m_nHeroID" > 0 GROUP BY entity_index
