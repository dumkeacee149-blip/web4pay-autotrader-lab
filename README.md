# Web4Pay Auto Trader Lab

A standalone static frontend prototype for BSC auto-trading (pixel style + TP/SL strategy UI), extracted from the web4pay experiment.

## Quick Start

```bash
python3 -m http.server 4174 --directory apps/web
```

Then open:

- http://127.0.0.1:4174/auto-trade.html

## GitHub Pages

This repo includes GitHub Pages deployment via GitHub Actions.

- Workflow file: `.github/workflows/deploy-pages.yml`
- Static site source: `apps/web`

After pushing to `main`, GitHub Pages will publish to:

- `https://dumkeacee149-blip.github.io/web4pay-autotrader-lab/`

> If it does not appear immediately, enable GitHub Pages in repository settings and wait for the workflow run.
