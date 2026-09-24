"""CLI smoke test - run one query through the real agent and print the full
trace, turn by turn. Needs a real ANTHROPIC_API_KEY and RAPIDAPI_KEY in .env.

Usage:
  python scripts/run_search.py "Sony WH-1000XM5 headphones"
"""

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.agent.orchestrator import run_agent


async def main():
    if len(sys.argv) < 2:
        print('Usage: python scripts/run_search.py "product query"')
        sys.exit(1)

    query = sys.argv[1]
    result = await run_agent(query)

    print("=" * 60)
    print("TRACE")
    print("=" * 60)
    for step in result.trace:
        print(json.dumps(step, indent=2, default=str))
    print("=" * 60)
    print("FINAL REPLY")
    print("=" * 60)
    print(result.final_text)


if __name__ == "__main__":
    asyncio.run(main())
