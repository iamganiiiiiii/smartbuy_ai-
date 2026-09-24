"""The tool-calling loop. Every tool result is fed back to the model as a
function_response part and the model decides the next step - that's the
difference between "agent" and "script that calls an LLM once".

MAX_TURNS is a hard stop: an ungrounded loop is a cost and correctness bug,
not just a UX issue.

Uses Google's Gemini API (function calling) - genuinely free tier, no
credit card - instead of a paid LLM API.
"""

from google import genai
from google.genai import types

from app.agent.prompts import ACTIVE_SYSTEM_PROMPT
from app.agent.tools import TOOL_SCHEMAS, dispatch
from app.config import settings

MAX_TURNS = 6

_FUNCTION_DECLARATIONS = [
    types.FunctionDeclaration(
        name=t["name"],
        description=t["description"],
        parameters_json_schema=t["input_schema"],
    )
    for t in TOOL_SCHEMAS
]
_TOOLS = [types.Tool(function_declarations=_FUNCTION_DECLARATIONS)]


class AgentRunResult:
    def __init__(
        self,
        final_text: str,
        trace: list[dict],
        best_listing: dict | None = None,
        other_listings: list[dict] | None = None,
        alternatives: list[dict] | None = None,
    ):
        self.final_text = final_text
        self.trace = trace
        self.best_listing = best_listing
        self.other_listings = other_listings or []
        self.alternatives = alternatives or []


async def run_agent(user_message: str) -> AgentRunResult:
    client = genai.Client(api_key=settings.gemini_api_key)
    config = types.GenerateContentConfig(system_instruction=ACTIVE_SYSTEM_PROMPT, tools=_TOOLS)

    contents: list[types.Content] = [types.Content(role="user", parts=[types.Part(text=user_message)])]
    trace: list[dict] = [{"role": "user", "text": user_message}]

    # Captured straight from tool results, not re-parsed from the model's
    # prose - the UI renders these as real cards (image, price, rating)
    # instead of trusting the model to format a table correctly in text.
    best_listing: dict | None = None
    other_listings: list[dict] = []
    alternatives: list[dict] = []

    for turn in range(MAX_TURNS):
        response = await client.aio.models.generate_content(
            model=settings.gemini_model,
            contents=contents,
            config=config,
        )

        candidate = response.candidates[0]
        contents.append(candidate.content)

        text = (response.text or "").strip()
        if text:
            trace.append({"role": "assistant", "text": text})

        function_calls = response.function_calls
        if not function_calls:
            return AgentRunResult(
                final_text=text,
                trace=trace,
                best_listing=best_listing,
                other_listings=other_listings,
                alternatives=alternatives,
            )

        function_response_parts = []
        for call in function_calls:
            call_args = dict(call.args or {})
            trace.append({"role": "tool_call", "tool": call.name, "input": call_args})
            result = await dispatch(call.name, call_args)
            trace.append({"role": "tool_result", "tool": call.name, "result": result})
            function_response_parts.append(types.Part.from_function_response(name=call.name, response=result))

            if call.name == "search_products" and result.get("best_listing"):
                best_listing = result["best_listing"]
                other_listings = result.get("other_listings") or []
            if call.name == "find_alternatives" and result.get("alternatives"):
                alternatives = [a["listing"] | {"value_score": a["value_score"], "reasoning": a["reasoning"]} for a in result["alternatives"]]

        contents.append(types.Content(role="user", parts=function_response_parts))

    return AgentRunResult(
        final_text="I wasn't able to finish this comparison within the allotted steps - please try a more specific search.",
        trace=trace,
        best_listing=best_listing,
        other_listings=other_listings,
        alternatives=alternatives,
    )
