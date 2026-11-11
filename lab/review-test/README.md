# Review test (lab)

A test of the replay review and quiz idea. Not part of Climb; nothing in the app links to it.
Open `lab/review-test/?m=<match id>` on the preview server (defaults to 135194126).

- `moments.js`: pure functions that find the moments worth a question and build each question's
  text from the moment's numbers. `node lab/review-test/moments-test.js` prints what it finds in
  every packed match.
- `tools/fetch.py <match> <account>` runs `q_*.sql` against the match's demo through deadlock-api
  (`POST /v1/matches/demo/query`, results are zstd NDJSON, cached in `tools/cache/`, git-ignored)
  and packs `matches/<match>.js` with `build.py`. Positions are `cell * 512 + vec - 32768`; 64 ticks a second; the
game clock is `tick / 64 - m_flGameStartTime`. Hero pawns map to players through the controller's
`m_hHeroPawn & 0x3FFF`.
