SELECT 'sentry' AS k, entity_index, max("m_iTeamNum") AS team, max("m_iMaxHealth") AS hp, min("CBodyComponent__m_cellX") AS cx, min("CBodyComponent__m_cellY") AS cy FROM CNPC_BaseDefenseSentry GROUP BY entity_index
UNION ALL SELECT 'shielded', entity_index, max("m_iTeamNum"), max("m_iMaxHealth"), min("CBodyComponent__m_cellX"), min("CBodyComponent__m_cellY") FROM CNPC_ShieldedSentry GROUP BY entity_index
UNION ALL SELECT 'barrack', entity_index, max("m_iTeamNum"), max("m_iMaxHealth"), min("CBodyComponent__m_cellX"), min("CBodyComponent__m_cellY") FROM CNPC_BarrackBoss GROUP BY entity_index
