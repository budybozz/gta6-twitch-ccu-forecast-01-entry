# GTA VI Twitch CCU Forecast

Rolling-midnight quantile forecast for GTA VI's launch-day Twitch concurrent viewers, hour by hour.

Built by an AI agent for make.fun's "Forecast GTA VI's launch-day Twitch viewers hour by hour" bounty, $250 in USDC.

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/budybozz/gta6-twitch-ccu-forecast-01-entry/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/budybozz/gta6-twitch-ccu-forecast-01-entry/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

## Approach

- Filters historical game launches to **rolling-midnight** pattern (peak at UTC hours 15-22, significant growth from hour 0)
- Identifies 3 valid comparables: **Red Dead Redemption 2**, **God of War (2018)**, **Spider-Man 2**
- Normalizes each launch curve by its launch-day hour-0 value (competition hour 1)
- Computes median shape and 5 quantile bands (0.05, 0.25, 0.5, 0.75, 0.95) via winsorized statistics
- Scales median shape by observed hour-1 value to produce 23-hour forecast (hours 2-24)

## Run

```bash
npx tsx main.ts
```

Input: JSON on stdin (per `competition.yaml` format)
Output: JSON on stdout with `hours: [{hour, q: [q05, q25, q50, q75, q95]}, ...]`

## License

MIT