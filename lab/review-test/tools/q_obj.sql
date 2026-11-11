SELECT kind, entity_index, team, min(tick) AS died, min(cx) AS cx, min(cy) AS cy, min(vx) AS vx, min(vy) AS vy FROM (
 SELECT 'guardian' AS kind, tick, entity_index, "m_iTeamNum" AS team, "m_lifeState" AS life, "CBodyComponent__m_cellX" AS cx, "CBodyComponent__m_cellY" AS cy, "CBodyComponent__m_vecX" AS vx, "CBodyComponent__m_vecY" AS vy FROM CNPC_TrooperBoss
 UNION ALL SELECT 'walker', tick, entity_index, "m_iTeamNum", "m_lifeState", "CBodyComponent__m_cellX", "CBodyComponent__m_cellY", "CBodyComponent__m_vecX", "CBodyComponent__m_vecY" FROM CNPC_Boss_Tier2
 UNION ALL SELECT 'basegd', tick, entity_index, "m_iTeamNum", "m_lifeState", "CBodyComponent__m_cellX", "CBodyComponent__m_cellY", "CBodyComponent__m_vecX", "CBodyComponent__m_vecY" FROM CNPC_BarrackBoss
 UNION ALL SELECT 'midboss', tick, entity_index, "m_iTeamNum", "m_lifeState", "CBodyComponent__m_cellX", "CBodyComponent__m_cellY", "CBodyComponent__m_vecX", "CBodyComponent__m_vecY" FROM CNPC_MidBoss
) WHERE life <> 0 GROUP BY kind, entity_index, team
