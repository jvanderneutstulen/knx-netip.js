# knx-netip.js
KNXnet/IP protocol stack in pure Javascript, capable of discovery, unicast tunneling and error handling and recovery.


Based on the work of EliasK, https://bitbucket.org/ekarak/knx.js

## Features
- uses Promises so you await group reads and writes
- fault handling using KNXnet/IP specs
- paces tunneling requests to prevent bus overload
