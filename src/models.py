"""Pydantic data models for canonical entity schemas in Pokémon GO reference dataset."""

from typing import List, Dict, Any, Optional
from pydantic import BaseModel, Field


class SpeciesModel(BaseModel):
    """Canonical schema model for a Pokémon species."""
    dex_number: int
    slug: str
    name: str
    family_slug: Optional[str] = None
    gen: int = 1
    region: str = "kanto"
    rarity: str = "standard"
    can_mega_evolve: bool = False
    can_gigantamax: bool = False
    pokedex_category: Optional[str] = None
    flavor_text: Optional[str] = None
    types: List[str] = Field(default_factory=list)


class FormModel(BaseModel):
    """Canonical schema model for a Pokémon form or variant."""
    slug: str
    species_slug: str
    dex_number: int
    form_name: str = "Standard"
    costume_name: Optional[str] = None
    # Curated, human-readable display name for costume_name's raw token (e.g.
    # "FASHION_2021_NOEVOLVE" -> "Fashionable costume"), sourced from
    # local_authoring's costume-lookup.json (Task 23). Additive, not a
    # replacement for costume_name: existing tests/consumers rely on
    # costume_name holding the raw token verbatim (e.g.
    # test_pokemon_go_api_frillish_cutover.py uses it as part of an identity
    # tuple), and the raw token is also the join key back to
    # costume_token_<token> claims -- overwriting it would destroy that.
    # None whenever costume_name is None (Standard forms) or its token has no
    # curated (non-empty) entry yet.
    costume_display_name: Optional[str] = None
    gender: str = "unknown"
    shiny_available: bool = False
    shiny_release_date: Optional[str] = None
    shadow_available: bool = False
    image_url: Optional[str] = None
    shiny_image_url: Optional[str] = None


class MoveModel(BaseModel):
    """Canonical schema model for a combat move."""
    move_id: int
    slug: str
    name: str
    type: str
    is_fast: bool = True
    pve_power: Optional[int] = None
    pve_energy: Optional[int] = None
    pvp_power: Optional[int] = None
    pvp_energy: Optional[int] = None


class DiscrepancyModel(BaseModel):
    """Schema model for cross-source attribute discrepancies."""
    entity_id: str
    attribute: str
    claims: List[Dict[str, Any]]
    resolved_value: Any
    winning_source: str
