"""Card helpers. A card is an int 0..51: ``rank * 4 + suit`` (rank 0='2' ... 12='A')."""

from __future__ import annotations

RANKS = "23456789TJQKA"
SUITS = "cdhs"


def card_str(card: int) -> str:
    return RANKS[card >> 2] + SUITS[card & 3]


def cards_str(cards) -> str:
    return " ".join(card_str(c) for c in cards)


def parse_card(text: str) -> int:
    return RANKS.index(text[0].upper()) * 4 + SUITS.index(text[1].lower())


def parse_cards(text: str) -> list[int]:
    return [parse_card(t) for t in text.split()]


def rank_of(card: int) -> int:
    return card >> 2


def suit_of(card: int) -> int:
    return card & 3
