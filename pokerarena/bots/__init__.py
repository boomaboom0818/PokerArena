"""Bot registry: describes how to (re)build a bot inside a worker process."""

from __future__ import annotations

import hashlib
import importlib
import importlib.util
import inspect
import sys
from dataclasses import dataclass, field
from pathlib import Path

from .base import Bot
from .builtin import BUILTIN

__all__ = ["Bot", "BotSpec", "BUILTIN", "builtin_specs", "specs_from_dir", "spec_from_string"]


@dataclass(frozen=True)
class BotSpec:
    """Picklable recipe for a bot.

    kind: ``builtin`` (target = registry name), ``file`` (target = path to a .py file),
    or ``module`` (target = importable module path). ``class_name`` picks the class.
    """

    name: str
    kind: str
    target: str
    class_name: str = ""
    kwargs: tuple = field(default_factory=tuple)  # tuple of (key, value)

    def build(self) -> Bot:
        cls = self._load_class()
        bot = cls(**dict(self.kwargs))
        return bot

    def _load_class(self):
        if self.kind == "builtin":
            return BUILTIN[self.target]
        if self.kind == "module":
            return getattr(importlib.import_module(self.target), self.class_name)
        module = _import_file(Path(self.target))
        return getattr(module, self.class_name)


def _import_file(path: Path):
    path = path.resolve()
    mod_name = "arena_bot_" + hashlib.md5(str(path).encode()).hexdigest()[:10]
    if mod_name in sys.modules:
        return sys.modules[mod_name]
    spec = importlib.util.spec_from_file_location(mod_name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    return module


def _bot_classes(module) -> list[type]:
    return [obj for _, obj in inspect.getmembers(module, inspect.isclass)
            if issubclass(obj, Bot) and obj is not Bot and obj.__module__ == module.__name__]


def builtin_specs(names=None) -> list[BotSpec]:
    names = list(names) if names else list(BUILTIN)
    unknown = [n for n in names if n not in BUILTIN]
    if unknown:
        raise KeyError(f"unknown built-in bot(s): {unknown}. Available: {sorted(BUILTIN)}")
    return [BotSpec(n, "builtin", n) for n in names]


def specs_from_file(path) -> list[BotSpec]:
    module = _import_file(Path(path))
    return [BotSpec(cls.name or cls.__name__, "file", str(Path(path).resolve()), cls.__name__)
            for cls in _bot_classes(module)]


def specs_from_dir(directory) -> list[BotSpec]:
    specs: list[BotSpec] = []
    for path in sorted(Path(directory).glob("*.py")):
        if path.name.startswith("_"):
            continue
        specs.extend(specs_from_file(path))
    return specs


def spec_from_string(text: str) -> list[BotSpec]:
    """``tag`` (builtin), ``path/to/bot.py`` (all bots in file), ``path/bot.py:Class``,
    or ``package.module:Class``."""
    if text in BUILTIN:
        return builtin_specs([text])
    target, _, cls_name = text.partition(":")
    if target.endswith(".py"):
        specs = specs_from_file(target)
        return [s for s in specs if not cls_name or s.class_name == cls_name]
    if cls_name:
        cls = getattr(importlib.import_module(target), cls_name)
        return [BotSpec(cls.name or cls.__name__, "module", target, cls_name)]
    raise KeyError(f"cannot resolve bot '{text}'")
