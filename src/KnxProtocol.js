/**
 * knx.js - a KNX protocol stack in pure Javascript
 * (C) 2016-2018 Elias Karakoulakis
 */

const util = require("util");
const ipaddr = require("ipaddr.js");
const Parser = require("binary-parser").Parser;
const BinaryProtocol = require("binary-protocol");
const KnxProtocol = new BinaryProtocol();
const KnxAddress = require("./Address");
const KnxConstants = require("./KnxConstants");
const KnxLog = require("./KnxLog");

// defaults
KnxProtocol.twoLevelAddressing = false;
// KnxProtocol.twoLevelAddressing = true;
KnxProtocol.lengths = {}; // TODO: Can this be a local variable, do we need to expose it?

// helper function: what is the byte length of an object?
const knxlen = (objectName, context) => {
  const lf = KnxProtocol.lengths[objectName];
  return typeof lf === "function" ? lf(context) : lf;
};

KnxProtocol.define("IPv4Endpoint", {
  read(propertyName) {
    this.pushStack({ addr: null, port: null })
      .raw("addr", 4)
      .UInt16BE("port")
      .tap((hdr) => {
        hdr.addr = ipaddr.fromByteArray(hdr.addr);
      })
      .popStack(propertyName, (data) => data.addr.toString() + ":" + data.port);
  },
  write(value) {
    if (!value) throw new Error("cannot write null value for IPv4Endpoint");

    if (typeof value !== "string" || !value.match(/\d*\.\d*\.\d*\.\d*:\d*/))
      throw new Error(
        "Invalid IPv4 endpoint, please set a string as  'ip.add.re.ss:port'"
      );

    const [addr, port] = value.split(":");
    this.raw(Buffer.from(ipaddr.parse(addr).toByteArray()), 4);
    this.UInt16BE(port);
  },
});
KnxProtocol.lengths.IPv4Endpoint = (value) => (value ? 6 : 0);

/* CRI: connection request/response */
// creq[22] = 0x04;  /* structure len (4 bytes) */
// creq[23] = 0x04;  /* connection type: DEVICE_MGMT_CONNECTION = 0x03; TUNNEL_CONNECTION = 0x04; */
// creq[24] = 0x02;  /* KNX Layer (Tunnel Link Layer) */
// creq[25] = 0x00;  /* Reserved */
// ==> 4 bytes
KnxProtocol.define("CRI", {
  read(propertyName) {
    this.pushStack({
      headerLength: 0,
      connectionType: null,
      knxLayer: null,
      unused: null,
    }) //
      .UInt8("headerLength")
      .UInt8("connectionType")
      .UInt8("knxLayer")
      .UInt8("unused")
      .tap((hdr) => {
        switch (hdr.connectionType) {
          case KnxConstants.CONNECTION_TYPE.DEVICE_MGMT_CONNECTION:
            break; // TODO
          case KnxConstants.CONNECTION_TYPE.TUNNEL_CONNECTION:
            break; // TODO
          default:
            throw new Error(
              "Unsupported connection type: " + hdr.connectionType
            );
        }
      })
      .popStack(propertyName, (data) => {
        if (KnxProtocol.debug)
          KnxLog.get().debug("read CRI: " + JSON.stringify(data));
        // pop the interim value off the stack and insert the real value into `propertyName`
        return data;
      });
  },
  write(value) {
    if (!value)
      return KnxLog.get().warn("CRI: cannot write null value for CRI");
    this.UInt8(0x04) // length
      .UInt8(value.connectionType)
      .UInt8(value.knxLayer)
      .UInt8(value.unused);
  },
});
KnxProtocol.lengths.CRI = (value) => (value ? 4 : 0);

// connection state response/request
KnxProtocol.define("ConnState", {
  read(propertyName) {
    this.pushStack({ channelId: null, status: null })
      .UInt8("channelId")
      .UInt8("status")
      .popStack(propertyName, (data) => {
        if (KnxProtocol.debug) KnxLog.get().trace("read ConnState: %j", data);
        return data;
      });
  },
  write(value) {
    if (!value)
      return KnxLog.get().error("cannot write null value for ConnState");
    this.UInt8(value.channelId).UInt8(value.status);
  },
});
KnxProtocol.lengths.ConnState = (value) => (value ? 2 : 0);

// connection state response/request
KnxProtocol.define("TunnState", {
  read(propertyName) {
    this.pushStack({
      headerLength: null,
      channelId: null,
      seqnum: null,
      status: null,
    })
      .UInt8("headerLength")
      .UInt8("channelId")
      .UInt8("seqnum")
      .UInt8("status")
      .tap((hdr) => {
        if (KnxProtocol.debug) KnxLog.get().trace("reading TunnState: %j", hdr);
        switch (hdr.status) {
          case 0x00:
            break;
          // default: throw "Connection State status: " + hdr.status;
        }
      })
      .popStack(propertyName, (data) => data);
  },
  write(value) {
    if (!value)
      return KnxLog.get().error(
        "TunnState: cannot write null value for TunnState"
      );
    if (KnxProtocol.debug) KnxLog.get().trace("writing TunnState: %j", value);
    this.UInt8(0x04)
      .UInt8(value.channelId)
      .UInt8(value.seqnum)
      .UInt8(value.status);
  },
});
KnxProtocol.lengths.TunnState = (value) => (value ? 4 : 0);

/* Connection HPAI */
//   creq[6]     =  /* Host Protocol Address Information (HPAI) Lenght */
//   creq[7]     =  /* IPv4 protocol UDP = 0x01, TCP = 0x02; */
//   creq[8-11]  =  /* IPv4 address  */
//   creq[12-13] =  /* IPv4 local port number for CONNECTION, CONNECTIONSTAT and DISCONNECT requests */
// ==> 8 bytes

/* Tunneling HPAI */
//   creq[14]    =  /* Host Protocol Address Information (HPAI) Lenght */
//   creq[15]    =  /* IPv4 protocol UDP = 0x01, TCP = 0x02; */
//   creq[16-19] =  /* IPv4 address  */
//   creq[20-21] =  /* IPv4 local port number for TUNNELING requests */
// ==> 8 bytes
KnxProtocol.define("HPAI", {
  read(propertyName) {
    this.pushStack({
      headerLength: 8,
      protocolType: null,
      tunnelEndpoint: null,
    })
      .UInt8("headerLength")
      .UInt8("protocolType")
      .IPv4Endpoint("tunnelEndpoint")
      .tap(function (hdr) {
        if (this.buffer.length < hdr.headerLength) {
          if (KnxProtocol.debug)
            KnxLog.get().trace(
              "%d %d %d",
              this.buffer.length,
              this.offset,
              hdr.headerLength
            );
          throw new Error("Incomplete KNXNet HPAI header");
        }
        if (KnxProtocol.debug) {
          KnxLog.get().trace(
            "read HPAI: %j, proto = %s",
            hdr,
            KnxConstants.keyText("PROTOCOL_TYPE", hdr.protocolType)
          );
        }
        switch (hdr.protocolType) {
          case KnxConstants.PROTOCOL_TYPE.IPV4_TCP:
            throw new Error("TCP is not supported");
          default:
        }
      })
      .popStack(propertyName, (data) => data);
  },
  write(value) {
    if (!value)
      return KnxLog.get().error("HPAI: cannot write null value for HPAI");

    this.UInt8(0x08) // length: 8 bytes
      .UInt8(value.protocolType)
      .IPv4Endpoint(value.tunnelEndpoint);
  },
});
KnxProtocol.lengths.HPAI = (value) => {
  return value ? 8 : 0;
};

KnxProtocol.define("DIBdevinfo", {
  read: function (propertyName) {
    this.pushStack({
      physicalAddr: null,
      serial: null,
      name: null,
      descriptionType: null,
      unused: null,
    })
      .UInt8("headerLength")
      .UInt8("descriptionType")
      .raw("unused", 2)
      .raw("physicalAddr", 2)
      .raw("unused", 2)
      .raw("serial", 6)
      .raw("unused", 4)
      .raw("unused", 6)
      .raw("name", 30)
      .tap(function (hdr) {
        if (this.buffer.length < hdr.headerLength) {
          if (KnxProtocol.debug)
            KnxLog.get().trace(
              "%d %d %d",
              this.buffer.length,
              this.offset,
              hdr.headerLength
            );
          throw new Error("Incomplete KNXNet DIB Devinfo header");
        }
        if (hdr.descriptionType !== 1) {
          throw new Error("Unknown Devinfo structure");
        }

        hdr.physicalAddr = KnxAddress.toString(
          hdr.physicalAddr,
          KnxAddress.TYPE.PHYSICAL,
          KnxProtocol.twoLevelAddressing
        );
        hdr.serial = hdr.serial.toString("hex");
        hdr.name = hdr.name.toString(
          "ascii",
          0,
          hdr.name.indexOf(0) !== -1 ? hdr.name.indexOf(0) : hdr.name.length
        );

        if (KnxProtocol.debug) {
          KnxLog.get().trace("read DIB devinfo: %j", hdr);
        }
      })
      .popStack(propertyName, function (data) {
        return data;
      });
  },
  write: function (value) {
    KnxLog.get().error("DIBdevinfo: not implemented");
  },
});
KnxProtocol.lengths.DIBdevinfo = function (value) {
  return value ? 54 : 0;
};

/* ==================== APCI ====================== */
//
//  Message Code    = 0x11 - a L_Data.req primitive
//      COMMON EMI MESSAGE CODES FOR DATA LINK LAYER PRIMITIVES
//          FROM NETWORK LAYER TO DATA LINK LAYER
//          +---------------------------+--------------+-------------------------+---------------------+------------------+
//          | Data Link Layer Primitive | Message Code | Data Link Layer Service | Service Description | Common EMI Frame |
//          +---------------------------+--------------+-------------------------+---------------------+------------------+
//          |        L_Raw.req          |    0x10      |                         |                     |                  |
//          +---------------------------+--------------+-------------------------+---------------------+------------------+
//          |                           |              |                         | Primitive used for  | Sample Common    |
//          |        L_Data.req         |    0x11      |      Data Service       | transmitting a data | EMI frame        |
//          |                           |              |                         | frame               |                  |
//          +---------------------------+--------------+-------------------------+---------------------+------------------+
//          |        L_Poll_Data.req    |    0x13      |    Poll Data Service    |                     |                  |
//          +---------------------------+--------------+-------------------------+---------------------+------------------+
//          |        L_Raw.req          |    0x10      |                         |                     |                  |
//          +---------------------------+--------------+-------------------------+---------------------+------------------+
//          FROM DATA LINK LAYER TO NETWORK LAYER
//          +---------------------------+--------------+-------------------------+---------------------+
//          | Data Link Layer Primitive | Message Code | Data Link Layer Service | Service Description |
//          +---------------------------+--------------+-------------------------+---------------------+
//          |        L_Poll_Data.con    |    0x25      |    Poll Data Service    |                     |
//          +---------------------------+--------------+-------------------------+---------------------+
//          |                           |              |                         | Primitive used for  |
//          |        L_Data.ind         |    0x29      |      Data Service       | receiving a data    |
//          |                           |              |                         | frame               |
//          +---------------------------+--------------+-------------------------+---------------------+
//          |        L_Busmon.ind       |    0x2B      |   Bus Monitor Service   |                     |
//          +---------------------------+--------------+-------------------------+---------------------+
//          |        L_Raw.ind          |    0x2D      |                         |                     |
//          +---------------------------+--------------+-------------------------+---------------------+
//          |                           |              |                         | Primitive used for  |
//          |                           |              |                         | local confirmation  |
//          |        L_Data.con         |    0x2E      |      Data Service       | that a frame was    |
//          |                           |              |                         | sent (does not mean |
//          |                           |              |                         | successful receive) |
//          +---------------------------+--------------+-------------------------+---------------------+
//          |        L_Raw.con          |    0x2F      |                         |                     |
//          +---------------------------+--------------+-------------------------+---------------------+

//  Add.Info Length = 0x00 - no additional info
//  Control Field 1 = see the bit structure above
//  Control Field 2 = see the bit structure above
//  Source Address  = 0x0000 - filled in by router/gateway with its source address which is
//                    part of the KNX subnet
//  Dest. Address   = KNX group or individual address (2 byte)
//  Data Length     = Number of bytes of data in the APDU excluding the TPCI/APCI bits
//  APDU            = Application Protocol Data Unit - the actual payload including transport
//                    protocol control information (TPCI), application protocol control
//                    information (APCI) and data passed as an argument from higher layers of
//                    the KNX communication stack

/* ==================== CEMI ====================== */

// CEMI (start at position 6)
// +--------+--------+--------+--------+----------------+----------------+--------+----------------+
// |  Msg   |Add.Info| Ctrl 1 | Ctrl 2 | Source Address | Dest. Address  |  Data  |      APDU      |
// | Code   | Length |        |        |                |                | Length |                |
// +--------+--------+--------+--------+----------------+----------------+--------+----------------+
//   1 byte   1 byte   1 byte   1 byte      2 bytes          2 bytes       1 byte      2 bytes
/*
Control Field 1
          Bit  |
         ------+---------------------------------------------------------------
           7   | Frame Type  - 0x0 for extended frame
               |               0x1 for standard frame
         ------+---------------------------------------------------------------
           6   | Reserved
         ------+---------------------------------------------------------------
           5   | Repeat Flag - 0x0 repeat frame on medium in case of an error
               |               0x1 do not repeat
         ------+---------------------------------------------------------------
           4   | System Broadcast - 0x0 system broadcast
               |                    0x1 broadcast
         ------+---------------------------------------------------------------
           3   | Priority    - 0x0 system
               |               0x1 normal
         ------+               0x2 urgent
           2   |       serviceType: -1,        0x3 low
         ------+---------------------------------------------------------------
           1   | Acknowledge Request - 0x0 no ACK requested
               | (L_Data.req)          0x1 ACK requested
         ------+---------------------------------------------------------------
           0   | Confirm      - 0x0 no error
               | (L_Data.con) - 0x1 error
         ------+---------------------------------------------------------------
Control Field 2
          Bit  |
         ------+---------------------------------------------------------------
           7   | Destination Address Type - 0x0 physical address, 0x1 group address
         ------+---------------------------------------------------------------
          6-4  | Hop Count (0-7)
         ------+---------------------------------------------------------------
          3-0  | Extended Frame Format - 0x0 standard frame
         ------+---------------------------------------------------------------
*/
// In the Common EMI frame, the APDU payload is defined as follows:

// +--------+--------+--------+--------+--------+
// | TPCI + | APCI + |  Data  |  Data  |  Data  |
// |  APCI  |  Data  |        |        |        |
// +--------+--------+--------+--------+--------+
//   byte 1   byte 2  byte 3     ...     byte 16

// For data that is 6 bits or less in length, only the first two bytes are used in a Common EMI
// frame. Common EMI frame also carries the information of the expected length of the Protocol
// Data Unit (PDU). Data payload can be at most 14 bytes long.  <p>

// The first byte is a combination of transport layer control information (TPCI) and application
// layer control information (APCI). First 6 bits are dedicated for TPCI while the two least
// significant bits of first byte hold the two most significant bits of APCI field, as follows:

//   Bit 1    Bit 2    Bit 3    Bit 4    Bit 5    Bit 6    Bit 7    Bit 8      Bit 1   Bit 2
// +--------+--------+--------+--------+--------+--------+--------+--------++--------+----....
// |        |        |        |        |        |        |        |        ||        |
// |  TPCI  |  TPCI  |  TPCI  |  TPCI  |  TPCI  |  TPCI  | APCI   |  APCI  ||  APCI  |
// |        |        |        |        |        |        |(bit 1) |(bit 2) ||(bit 3) |
// +--------+--------+--------+--------+--------+--------+--------+--------++--------+----....
// +                            B  Y  T  E    1                            ||       B Y T E  2
// +-----------------------------------------------------------------------++-------------....

// Total number of APCI control bits can be either 4 or 10. The second byte bit structure is as follows:

//   Bit 1    Bit 2    Bit 3    Bit 4    Bit 5    Bit 6    Bit 7    Bit 8      Bit 1   Bit 2
// +--------+--------+--------+--------+--------+--------+--------+--------++--------+----....
// |        |        |        |        |        |        |        |        ||        |
// |  APCI  |  APCI  | APCI/  |  APCI/ |  APCI/ |  APCI/ | APCI/  |  APCI/ ||  Data  |  Data
// |(bit 3) |(bit 4) | Data   |  Data  |  Data  |  Data  | Data   |  Data  ||        |
// +--------+--------+--------+--------+--------+--------+--------+--------++--------+----....
// +                            B  Y  T  E    2                            ||       B Y T E  3
// +-----------------------------------------------------------------------++-------------....

// control field
const ctrlStruct = new Parser()
  // byte 1
  .bit1("frameType")
  .bit1("reserved")
  .bit1("repeat")
  .bit1("broadcast")
  .bit2("priority")
  .bit1("acknowledge")
  .bit1("confirm")
  // byte 2
  .bit1("destAddrType")
  .bit3("hopCount")
  .bit4("extendedFrame");

// APDU: 2 bytes, tcpi = 6 bits, apci = 4 bits, remaining 6 bits = data (when length=1)
KnxProtocol.apduStruct = new Parser().bit6("tpci").bit4("apci").bit6("data");

KnxProtocol.define("APDU", {
  read(propertyName) {
    this.pushStack({
      apduLength: null,
      apduRaw: null,
      tpci: null,
      apci: null,
      data: null,
    })
      .UInt8("apduLength")
      .tap(function (hdr) {
        // if (KnxProtocol.debug) KnxLog.get().trace('--- parsing extra %d apdu bytes', hdr.apduLength+1);
        this.raw("apduRaw", hdr.apduLength + 1);
      })
      .tap((hdr) => {
        // Parse the APDU. tcpi/apci bits split across byte boundary.
        // Typical example of protocol designed by committee.
        const apdu = KnxProtocol.apduStruct.parse(hdr.apduRaw);
        hdr.tpci = apdu.tpci;
        hdr.apci = KnxConstants.APCICODES[apdu.apci];
        // APDU data should ALWAYS be a buffer, even for 1-bit payloads
        hdr.data =
          hdr.apduLength > 1 ? hdr.apduRaw.slice(2) : Buffer.from([apdu.data]);
        if (KnxProtocol.debug)
          KnxLog.get().trace(" unmarshalled APDU: %j", hdr);
      })
      .popStack(propertyName, (data) => data);
  },
  write(value) {
    if (!value) throw new Error("cannot write null APDU value");
    const totalLength = knxlen("APDU", value);
    // if (KnxProtocol.debug) KnxLog.get().trace('APDU.write: \t%j (total %d bytes)', value, totalLength);
    if (KnxConstants.APCICODES.indexOf(value.apci) === -1)
      return KnxLog.get().error("invalid APCI code: %j", value);
    if (totalLength < 3)
      throw new Error(util.format("APDU is too small (%d bytes)", totalLength));
    if (totalLength > 17)
      throw new Error(util.format("APDU is too big (%d bytes)", totalLength));
    // camel designed by committee: total length MIGHT or MIGHT NOT include the payload
    //     APDU length (1 byte) + TPCI/APCI: 6+4 bits + DATA: 6 bits (2 bytes)
    // OR: APDU length (1 byte) + TPCI/APCI: 6+4(+6 unused) bits (2bytes) + DATA: (1 to 14 bytes))
    this.UInt8(totalLength - 2);
    let word =
      value.tpci * 0x400 + KnxConstants.APCICODES.indexOf(value.apci) * 0x40;
    //
    if (totalLength === 3) {
      // payload embedded in the last 6 bits
      word += parseInt(
        isFinite(value.data) && typeof value.data !== "object"
          ? value.data
          : value.data[0]
      );
      this.UInt16BE(word);
    } else {
      this.UInt16BE(word);
      // payload follows TPCI+APCI word
      // KnxLog.get().trace('~~~%s, %j, %d', typeof value.data, value.data, totalLength);
      this.raw(Buffer.from(value.data, totalLength - 3));
    }
  },
});

/* APDU length is truly chaotic: header and data can be interleaved (but
not always!), so that apduLength=1 means _2_ bytes following the apduLength */
KnxProtocol.lengths.APDU = (value) => {
  if (!value) return 0;
  // if we have the APDU bitlength, usually by the DPT, then simply use it
  if (value.bitlength || (value.data && value.data.bitlength)) {
    const bitlen = value.bitlength || value.data.bitlength;
    // KNX spec states that up to 6 bits of payload must fit into the TPCI
    // if payload larger than 6 bits, than append it AFTER the TPCI
    return 3 + (bitlen > 6 ? Math.ceil(bitlen / 8) : 0);
  }
  // not all requests carry a value; eg read requests
  if (!value.data) value.data = 0;
  if (value.data.length) {
    if (value.data.length < 1) throw new Error("APDU value is empty");
    if (value.data.length > 14)
      throw new Error("APDU value too big, must be <= 14 bytes");
    if (value.data.length === 1) {
      const v = value.data[0];
      if (!isNaN(parseFloat(v)) && isFinite(v) && v >= 0 && v <= 63) {
        // apduLength + tpci/apci/6-bit integer == 1+2 bytes
        return 3;
      }
    }
    return 3 + value.data.length;
  } else {
    if (
      !isNaN(parseFloat(value.data)) &&
      isFinite(value.data) &&
      value.data >= 0 &&
      value.data <= 63
    ) {
      return 3;
    } else {
      KnxLog.get().warn(
        "Fix your code - APDU data payload must be a 6-bit int or an Array/Buffer (1 to 14 bytes), got: %j (%s)",
        value.data,
        typeof value.data
      );
      throw new Error(
        "APDU payload must be a 6-bit int or an Array/Buffer (1 to 14 bytes)"
      );
    }
  }
};

KnxProtocol.define("CEMI", {
  read(propertyName) {
    this.pushStack({
      msgcode: 0,
      addinfoLength: -1,
      ctrl: null,
      srcAddr: null,
      destAddr: null,
      apdu: null,
    })
      .UInt8("msgcode")
      .UInt8("addinfoLength")
      .raw("ctrl", 2)
      .raw("srcAddr", 2)
      .raw("destAddr", 2)
      .tap(function (hdr) {
        // parse 16bit control field
        hdr.ctrl = ctrlStruct.parse(hdr.ctrl);
        // KNX source addresses are always physical
        hdr.srcAddr = KnxAddress.toString(
          hdr.srcAddr,
          KnxAddress.TYPE.PHYSICAL,
          KnxProtocol.twoLevelAddressing
        );
        hdr.destAddr = KnxAddress.toString(
          hdr.destAddr,
          hdr.ctrl.destAddrType,
          KnxProtocol.twoLevelAddressing
        );
        switch (hdr.msgcode) {
          case KnxConstants.MESSAGECODES["L_Data.req"]:
          case KnxConstants.MESSAGECODES["L_Data.ind"]:
          case KnxConstants.MESSAGECODES["L_Data.con"]: {
            this.APDU("apdu");
            if (KnxProtocol.debug)
              KnxLog.get().trace("--- unmarshalled APDU ==> %j", hdr.apdu);
          }
        }
      })
      .popStack(propertyName, (data) => data);
  },
  write(value) {
    if (!value) throw new Error("cannot write null CEMI value");
    if (KnxProtocol.debug) KnxLog.get().trace("CEMI.write: \n\t%j", value);
    if (value.ctrl === null) throw new Error("no Control Field supplied");
    const ctrlField1 =
      value.ctrl.frameType * 0x80 +
      value.ctrl.reserved * 0x40 +
      value.ctrl.repeat * 0x20 +
      value.ctrl.broadcast * 0x10 +
      value.ctrl.priority * 0x04 +
      value.ctrl.acknowledge * 0x02 +
      value.ctrl.confirm;
    const ctrlField2 =
      value.ctrl.destAddrType * 0x80 +
      value.ctrl.hopCount * 0x10 +
      value.ctrl.extendedFrame;
    this.UInt8(value.msgcode)
      .UInt8(value.addinfoLength)
      .UInt8(ctrlField1)
      .UInt8(ctrlField2)
      .raw(
        KnxAddress.parse(
          value.srcAddr,
          KnxAddress.TYPE.PHYSICAL,
          KnxProtocol.twoLevelAddressing
        ),
        2
      )
      .raw(
        KnxAddress.parse(
          value.destAddr,
          value.ctrl.destAddrType,
          KnxProtocol.twoLevelAddressing
        ),
        2
      );
    // only need to marshal an APDU if this is a
    // L_Data.* (requet/indication/confirmation)
    switch (value.msgcode) {
      case KnxConstants.MESSAGECODES["L_Data.req"]:
      case KnxConstants.MESSAGECODES["L_Data.ind"]:
      case KnxConstants.MESSAGECODES["L_Data.con"]: {
        if (value.apdu === null) throw new Error("no APDU supplied)");
        this.APDU(value.apdu);
      }
    }
  },
});
KnxProtocol.lengths.CEMI = (value) => {
  if (!value) return 0;
  const apduLength = knxlen("APDU", value.apdu);
  if (KnxProtocol.debug)
    KnxLog.get().trace("knxlen of cemi: %j == %d", value, 8 + apduLength);
  return 8 + apduLength;
};

KnxProtocol.define("KNXNetHeader", {
  read(propertyName) {
    this.pushStack({
      headerLength: 0,
      protocolVersion: -1,
      serviceType: -1,
      totalLength: 0,
    })
      .UInt8("headerLength")
      .UInt8("protocolVersion")
      .UInt16BE("serviceType")
      .UInt16BE("totalLength")
      .tap(function (hdr) {
        if (KnxProtocol.debug) KnxLog.get().trace("read KNXNetHeader :%j", hdr);
        if (this.buffer.length + hdr.headerLength < this.totalLength)
          throw new Error(
            util.format(
              "Incomplete KNXNet packet: got %d bytes (expected %d)",
              this.buffer.length + hdr.headerLength,
              this.totalLength
            )
          );
        switch (hdr.serviceType) {
          case KnxConstants.SERVICE_TYPE.SEARCH_REQUEST:
          case KnxConstants.SERVICE_TYPE.CONNECT_REQUEST: {
            this.HPAI("hpai").HPAI("tunn").CRI("cri");
            break;
          }
          case KnxConstants.SERVICE_TYPE.SEARCH_RESPONSE: {
            this.HPAI("hpai");
            this.DIBdevinfo("devinfo");
            break;
          }
          case KnxConstants.SERVICE_TYPE.CONNECT_RESPONSE:
          case KnxConstants.SERVICE_TYPE.CONNECTIONSTATE_REQUEST:
          case KnxConstants.SERVICE_TYPE.CONNECTIONSTATE_RESPONSE:
          case KnxConstants.SERVICE_TYPE.DISCONNECT_REQUEST:
          case KnxConstants.SERVICE_TYPE.DISCONNECT_RESPONSE: {
            this.ConnState("connstate");
            if (hdr.totalLength > 8) this.HPAI("hpai");
            if (hdr.totalLength > 16) this.CRI("cri");
            break;
          }
          case KnxConstants.SERVICE_TYPE.DESCRIPTION_RESPONSE: {
            this.raw("value", hdr.totalLength);
            break;
          }
          // most common case:
          case KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST:
            this.TunnState("tunnstate");
            this.CEMI("cemi");
            break;
          case KnxConstants.SERVICE_TYPE.TUNNELING_ACK:
            this.TunnState("tunnstate");
            break;
          case KnxConstants.SERVICE_TYPE.ROUTING_INDICATION:
            this.CEMI("cemi");
            break;
          default: {
            KnxLog.get().warn(
              "read KNXNetHeader: unhandled serviceType = %s",
              KnxConstants.keyText("SERVICE_TYPE", hdr.serviceType)
            );
          }
        }
      })
      .popStack(propertyName, (data) => {
        if (KnxProtocol.debug)
          KnxLog.get().trace(JSON.stringify(data, null, 4));
        return data;
      });
  },
  write(value) {
    if (!value) throw new Error("cannot write null KNXNetHeader value");
    value.totalLength = knxlen("KNXNetHeader", value);
    if (KnxProtocol.debug) KnxLog.get().trace("writing KnxHeader:", value);
    this.UInt8(6) // header length (6 bytes constant)
      .UInt8(0x10) // protocol version 1.0
      .UInt16BE(value.serviceType)
      .UInt16BE(value.totalLength);
    switch (value.serviceType) {
      // case SERVICE_TYPE.SEARCH_REQUEST:
      case KnxConstants.SERVICE_TYPE.SEARCH_REQUEST:
      case KnxConstants.SERVICE_TYPE.CONNECT_REQUEST: {
        if (value.hpai) this.HPAI(value.hpai);
        if (value.tunn) this.HPAI(value.tunn);
        if (value.cri) this.CRI(value.cri);
        break;
      }
      case KnxConstants.SERVICE_TYPE.SEARCH_RESPONSE:
      case KnxConstants.SERVICE_TYPE.CONNECT_RESPONSE:
      case KnxConstants.SERVICE_TYPE.CONNECTIONSTATE_REQUEST:
      case KnxConstants.SERVICE_TYPE.CONNECTIONSTATE_RESPONSE:
      case KnxConstants.SERVICE_TYPE.DISCONNECT_REQUEST: {
        if (value.connstate) this.ConnState(value.connstate);
        if (value.hpai) this.HPAI(value.hpai);
        if (value.cri) this.CRI(value.cri);
        break;
      }
      // most common case:
      case KnxConstants.SERVICE_TYPE.ROUTING_INDICATION:
      case KnxConstants.SERVICE_TYPE.TUNNELING_ACK:
      case KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST: {
        if (value.tunnstate) this.TunnState(value.tunnstate);
        if (value.cemi) this.CEMI(value.cemi);
        break;
      }
      // case KnxConstants.SERVICE_TYPE.DESCRIPTION_RESPONSE: {
      default: {
        throw util.format(
          "write KNXNetHeader: unhandled serviceType = %s (%j)",
          KnxConstants.keyText("SERVICE_TYPE", value),
          value
        );
      }
    }
  },
});
KnxProtocol.lengths.KNXNetHeader = (value) => {
  if (!value) throw new Error("Must supply a valid KNXNetHeader value");
  switch (value.serviceType) {
    // case SERVICE_TYPE.SEARCH_REQUEST:
    case KnxConstants.SERVICE_TYPE.SEARCH_REQUEST:
    case KnxConstants.SERVICE_TYPE.CONNECT_REQUEST:
      return (
        6 +
        knxlen("HPAI", value.hpai) +
        knxlen("HPAI", value.tunn) +
        knxlen("CRI", value.cri)
      );
    case KnxConstants.SERVICE_TYPE.SEARCH_RESPONSE:
    case KnxConstants.SERVICE_TYPE.CONNECT_RESPONSE:
    case KnxConstants.SERVICE_TYPE.CONNECTIONSTATE_REQUEST:
    case KnxConstants.SERVICE_TYPE.CONNECTIONSTATE_RESPONSE:
    case KnxConstants.SERVICE_TYPE.DISCONNECT_REQUEST:
      return (
        6 +
        knxlen("ConnState", value.connstate) +
        knxlen("HPAI", value.hpai) +
        knxlen("CRI", value.cri)
      );
    case KnxConstants.SERVICE_TYPE.TUNNELING_ACK:
    case KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST:
      return (
        6 + knxlen("TunnState", value.tunnstate) + knxlen("CEMI", value.cemi)
      );
    case KnxConstants.SERVICE_TYPE.ROUTING_INDICATION:
      return 6 + knxlen("CEMI", value.cemi);
  }
};

module.exports = KnxProtocol;
