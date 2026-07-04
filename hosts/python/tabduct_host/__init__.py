"""Tabduct native host — Python implementation.

A language-neutral port of the Node reference host (hosts/node/src/). Speaks
Chrome native-messaging on stdio (south edge) and the MCP streamable-HTTP
protocol on 127.0.0.1 (north edge). The shared extension + protocol are reused
unchanged; this package only adds a second host implementation.
"""

__version__ = "0.0.1"
