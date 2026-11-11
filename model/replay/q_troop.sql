SELECT tick, entity_index, "m_iTeamNum" AS team, "m_lifeState" AS life, "CBodyComponent__m_cellX" AS cx, "CBodyComponent__m_cellY" AS cy, "CBodyComponent__m_vecX" AS vx, "CBodyComponent__m_vecY" AS vy
FROM CNPC_Trooper WHERE tick % 128 = 0
