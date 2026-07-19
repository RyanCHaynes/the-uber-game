"""Standalone enemy/boss authoring tool.

An isolated workshop for designing game entities (simple enemies through
multi-part bosses) with the same NVIDIA Nemotron setup the main design agent
uses. It generates an EntitySpec from a natural-language description, validates
it against the closed vocabulary from
``agent/entity/llm_adaptive_boss_system_plan.md``, and renders a static
structural preview and live simulation. The workshop and shipped game share
``agent/web/entity_runtime.js``, so a validated workshop behavior runs through
the same interpreter that executes it in a scrolling CSV level.

Run it with::

    AGENT_MOCK=1 python -m agent.entity.webui   # deterministic, no API key
    NVIDIA_API_KEY=... python -m agent.entity.webui
"""
