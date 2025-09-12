Football LLM Experimentation Repo

This repository contains experiments and tools for building a system that generates real-time betting-style questions from football (soccer) match data. The goal is to test how well a large language model (LLM) can understand raw or compressed match data and produce engaging, market-aligned questions for fans playing along in a mobile app.

📂 Repository Structure
1. data_model_compressed/

Contains examples of nine proposed data models for compressing raw football event data into more compact snapshots.

Each model captures a different aspect of the match (e.g. state, trends, momentum, fouls, player threats, etc.).

Used to test whether an LLM can still perform well with reduced context compared to full raw data.

2. experiment/

Holds chunks of game data (e.g. 30-minute segments) that were produced during experiments.

These chunks are used to compare how the LLM performs with raw data vs. compressed data.

3. llm-facets/

Contains the logic for facet extraction.

A “facet” is a compressed view of a specific game element (e.g. team momentum, substitutions, card discipline).

Includes the facet_server.js tool, which allows the LLM to request additional facets on demand if the base compressed snapshot is not enough to generate good questions.

4. snapshots/

Stores 5-minute snapshots of matches in both raw and compressed forms.

raw/ → original event data for that time window.

compressed/ → reduced snapshots using one or more of the compression models.

5. Raw Game JSON Files

Full match JSON files (StatsBomb format or similar).

These are the starting point for snapshotting and compression.

6. Scripts

experiment.js → runs experiments comparing raw vs. compressed data.

replay-server.js → replays full games or selected windows at variable speed for testing.

snapshotter.js → cuts games into 5-minute raw snapshots, which can then be compressed.

🚀 Workflow

Start with a raw game JSON (e.g. Barcelona vs Alavés).

Generate 5-minute snapshots using snapshotter.js.

Raw snapshots go into snapshots/raw/.

Compress snapshots into one or more reduced models (e.g. STKM, PAD, PTF).

Compressed snapshots go into snapshots/compressed/.

Run experiments with experiment.js to test:

Raw vs compressed data for LLM question generation.

LLM performance when requesting extra facets via the facet server.

Replay games with replay-server.js to simulate live streaming and question timing.

🎯 Purpose

This repo is an R&D sandbox for validating a key hypothesis:
👉 Can an LLM generate equally strong, betting-style, multiple-choice questions from compressed match data as it can from full raw event feeds?

If yes, then the compressed format allows:

Lower token usage (cheaper, faster).

Easier context management for long games.

More control over what information the LLM sees.

🎮 Running the Game Simulator

To run the interactive football quiz simulator:

1. **Setup Environment**: Create a `.env` file with your API keys:
   ```
   GEMINI_API_KEY=your_gemini_api_key
   SUPABASE_URL=your_supabase_url
   SUPABASE_SERVICE_KEY=your_service_key
   ```

2. **Start Supabase**: Run `supabase start` to start your local database

3. **Populate Database**: Run the snapshot services in this order to populate your database:
   - `node snapshot_writer_service/src/index.js` (snapshot writer service)
   - `node snapshot_writer_service/bridge_sse_to_snapshot.js` (bridge to replay server)
   - `node sb-replay-server.js` (replay server)

4. **Run Simulator**: Once your database is populated, start the simulator and facet server:
   - `node llm-facets/facet_server.js` (facet server)
   - `node game_simulator.js` (game simulator)

The simulator will load snapshots from your database and generate interactive questions for different game periods.

📌 Notes for New Contributors

No prior experiments are required to use the repo, but some familiarity with JSON football data (e.g. StatsBomb) helps.

File naming is important: snapshots must follow the <gameId>-<start>-<end>.json format for the facet server to find them.

The LLM is expected to:

Read compressed snapshots (starting with STKM, the State-Trend-Key Moments model).

Request extra facets only if needed, via the facet server.

