# Review test (lab)

A throwaway test of the replay review and quiz idea, on one match (135194126). Not part of Climb;
nothing in the app links to it. Open `lab/review-test/` on the preview server.

`tools/` rebuilds `data.js`: `dq.py` runs SQL on a match's demo through deadlock-api
(`POST /v1/matches/demo/query`, results are zstd NDJSON), `q_*.sql` are the queries, and
`build.py data.js` packs them. Positions are `cell * 512 + vec - 32768`; 64 ticks a second; the
game clock is `tick / 64 - m_flGameStartTime`. Hero pawns map to players through the controller's
`m_hHeroPawn & 0x3FFF`.
