/**
 * knx.js - a KNX protocol stack in pure Javascript
 * (C) 2016-2018 Elias Karakoulakis
 */

const { v4: uuidv4 } = require("uuid");

const DPTLib = require("./dptlib");
const KnxLog = require("./KnxLog");
const KnxConstants = require("./KnxConstants");
const KnxNetProtocol = require("./KnxProtocol");

class KnxDatagram {
  constructor(options) {
    this._options = Object.assign(
      {
        suppress_ack_ldatareq: true,
        use_tunneling: true,
        twoLevelAddressing: true,
      },
      options || {}
    );
    this.useTunneling = this._options.use_tunneling;
    this._channelID = null;
    this._remoteControlEndpoint = null;

    this.datagram = {};
    this.uuid = uuidv4();

    KnxNetProtocol.twoLevelAddressing = this._options.twoLevelAddressing;
  }

  buildDatagram(svcType, remoteControlEndpoint, channelID) {
    this._channelID = channelID || null;
    this._remoteControlEndpoint = remoteControlEndpoint || null;

    this.datagram = {
      headerLength: 6,
      protocolVersion: 16, // 0x10 == version 1.0
      serviceType: svcType,
      totalLength: null, // filled in automatically
    };

    this.addHPAI();

    switch (svcType) {
      case KnxConstants.SERVICE_TYPE.SEARCH_REQUEST:
        break;
      case KnxConstants.SERVICE_TYPE.CONNECT_REQUEST:
        this.addTunn();
        this.addCRI();
      // falls through
      case KnxConstants.SERVICE_TYPE.CONNECTIONSTATE_REQUEST:
      case KnxConstants.SERVICE_TYPE.DISCONNECT_REQUEST:
        this.addConnState();
        break;
      case KnxConstants.SERVICE_TYPE.ROUTING_INDICATION:
        this.addCEMI(KnxConstants.MESSAGECODES["L_Data.ind"]);
        break;
      case KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST:
        this.addTunn();
        this.addTunnState();
        this.addCEMI();
        break;
      case KnxConstants.SERVICE_TYPE.TUNNELING_ACK:
        this.addTunnState();
        break;
      default:
        KnxLog.get().debug("Do not know how to deal with svc type %d", svcType);
    }
  }

  static fromServiceRequest(
    svcType,
    options,
    remoteControlEndpoint,
    channelID
  ) {
    const dg = new KnxDatagram(options);
    dg.buildDatagram(svcType, remoteControlEndpoint, channelID);
    return dg;
  }

  addHPAI() {
    this.datagram.hpai = {
      protocolType: 1, // UDP
      tunnelEndpoint: "0.0.0.0:0",
    };
  }

  addTunn() {
    this.datagram.tunn = {
      protocolType: 1, // UDP
      tunnelEndpoint: "0.0.0.0:0",
    };
  }

  addCRI() {
    this.datagram.cri = {
      connectionType: KnxConstants.CONNECTION_TYPE.TUNNEL_CONNECTION,
      knxLayer: KnxConstants.KNX_LAYER.LINK_LAYER,
      unused: 0,
    };
  }

  addConnState() {
    if (this._channelID === null) {
      KnxLog.get().warn("Channel ID is unknown when adding ConnState");
    }
    this.datagram.connstate = {
      channelId: this._channelID,
      state: 0,
    };
  }

  addTunnState() {
    if (this._channelID === null) {
      KnxLog.get().warn("Channel ID is unknown when adding TunnState");
    }
    if (this._remoteControlEndpoint === null) {
      KnxLog.get().warn(
        "Remote Control Endpoint is unknown when adding TunnState"
      );
    }
    // add the remote IP router's endpoint
    this.datagram.tunnstate = {
      channelId: this._channelID,
      tunnelEndpoint:
        this._remoteControlEndpoint.addr +
        ":" +
        this._remoteControlEndpoint.port,
    };
  }

  addCEMI(msgcode) {
    msgcode = msgcode || KnxConstants.MESSAGECODES["L_Data.req"];
    const sendAck =
      msgcode === KnxConstants.MESSAGECODES["L_Data.req"] &&
      !this._options.suppress_ack_ldatareq;
    this.datagram.cemi = {
      msgcode: msgcode || 0x11, // default: L_Data.req for tunneling
      ctrl: {
        frameType: 1, // 0=extended 1=standard
        reserved: 0, // always 0
        repeat: 1, // the OPPOSITE: 1=do NOT repeat
        broadcast: 1, // 0-system broadcast 1-broadcast
        priority: 3, // 0-system 1-normal 2-urgent 3-low
        acknowledge: sendAck ? 1 : 0,
        confirm: 0, // FIXME: only for L_Data.con 0-ok 1-error
        // 2nd byte
        destAddrType: 1, // FIXME: 0-physical 1-groupaddr
        hopCount: 6,
        extendedFrame: 0,
      },
      srcAddr: this._options.physAddr || "15.15.15",
      destAddr: "0/0/0", //
      apdu: {
        // default operation is GroupValue_Write
        apci: "GroupValue_Write",
        tpci: 0,
        data: 0,
      },
    };
  }

  getSeqNum() {
    return this.datagram.tunnstate.seqnum || -1;
  }

  setSeqNum(seqnum) {
    this.datagram.tunnstate.seqnum = seqnum;
  }

  getServiceType() {
    return KnxConstants.keyText("SERVICE_TYPE", this.datagram.serviceType);
  }

  _makeRequest(type, datagramTemplate) {
    // decorate the datagram, if a function is passed
    if (typeof datagramTemplate === "function") {
      datagramTemplate(this.datagram);
    }
    this.datagram.serviceType = type;
  }

  makeReadRequest(grpaddr) {
    const serviceType = this.useTunneling
      ? KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST
      : KnxConstants.SERVICE_TYPE.ROUTING_INDICATION;
    this._makeRequest(serviceType, function (datagram) {
      datagram.cemi.apdu.apci = "GroupValue_Read";
      datagram.cemi.destAddr = grpaddr;
      return datagram;
    });
  }

  makeRespondRequest(grpaddr, value, dptid) {
    if (grpaddr == null || value == null) {
      KnxLog.get().warn("You must supply both grpaddr and value!");
      return;
    }
    const serviceType = this.useTunneling
      ? KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST
      : KnxConstants.SERVICE_TYPE.ROUTING_INDICATION;
    this._makeRequest(serviceType, function (datagram) {
      DPTLib.populateAPDU(value, datagram.cemi.apdu, dptid);
      datagram.cemi.apdu.apci = "GroupValue_Response";
      datagram.cemi.destAddr = grpaddr;
      return datagram;
    });
  }

  makeWriteRequest(grpaddr, value, dptid) {
    if (grpaddr == null || value == null) {
      KnxLog.get().warn("You must supply both grpaddr and value!");
      return;
    }
    const serviceType = this.useTunneling
      ? KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST
      : KnxConstants.SERVICE_TYPE.ROUTING_INDICATION;
    this._makeRequest(serviceType, function (datagram) {
      DPTLib.populateAPDU(value, datagram.cemi.apdu, dptid);
      datagram.cemi.destAddr = grpaddr;
    });
  }

  makeWriteRawRequest(grpaddr, value, bitlength) {
    if (grpaddr == null || value == null) {
      KnxLog.get().warn("You must supply both grpaddr and value!");
      return;
    }
    if (!Buffer.isBuffer(value)) {
      KnxLog.get().warn("Value must be a buffer!");
      return;
    }
    const serviceType = this.useTunneling
      ? KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST
      : KnxConstants.SERVICE_TYPE.ROUTING_INDICATION;
    this._makeRequest(serviceType, function (datagram) {
      datagram.cemi.apdu.data = value;
      datagram.cemi.apdu.bitlength = bitlength || value.byteLength * 8;
      datagram.cemi.destAddr = grpaddr;
    });
  }

  send(socket, remote, callback) {
    let cemitype; // TODO: set, but unused
    try {
      const writer = KnxNetProtocol.createWriter();
      switch (this.datagram.serviceType) {
        case KnxConstants.SERVICE_TYPE.ROUTING_INDICATION:
        case KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST:
          // append the CEMI service type if this is a tunneling request...
          cemitype = KnxConstants.keyText(
            "MESSAGECODES",
            this.datagram.cemi.msgcode
          );
          break;
      }
      const packet = writer.KNXNetHeader(this.datagram);
      const buf = packet.buffer;
      const svctype = KnxConstants.keyText(
        "SERVICE_TYPE",
        this.datagram.serviceType
      ); // TODO: unused
      const descr = this.datagramDesc();
      KnxLog.get().trace("Sending %s ==> %j", descr, this.datagram);
      socket.send(
        buf,
        0,
        buf.length,
        remote.port,
        remote.addr.toString(),
        (err) => {
          KnxLog.get().trace(
            "UDP sent %s: %s %s",
            err ? err.toString() : "OK",
            descr,
            buf.toString("hex")
          );
        }
      );
    } catch (e) {
      KnxLog.get().warn(e);
      if (typeof callback === "function") callback(e);
    }
  }

  // return a descriptor for this datagram (TUNNELING_REQUEST_L_Data.ind)
  datagramDesc() {
    let blurb = KnxConstants.keyText("SERVICE_TYPE", this.datagram.serviceType);
    if (
      this.datagram.serviceType ===
        KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST ||
      this.datagram.serviceType === KnxConstants.SERVICE_TYPE.ROUTING_INDICATION
    ) {
      blurb +=
        "_" + KnxConstants.keyText("MESSAGECODES", this.datagram.cemi.msgcode);
    }
    return blurb;
  }

  static parseKnxMessage(channelID, msg, rinfo, options, callback) {
    try {
      const reader = KnxNetProtocol.createReader(msg);
      reader.KNXNetHeader("tmp");
      const dg = new KnxDatagram(options);
      dg.datagram = reader.next().tmp;
      const descr = dg.datagramDesc();
      KnxLog.get().trace("Received %s message: %j", descr, dg.datagram);
      if (
        channelID !== null &&
        ((Object.prototype.hasOwnProperty.call(dg.datagram, "connstate") &&
          dg.datagram.connstate.channelId !== channelID) ||
          (Object.prototype.hasOwnProperty.call(dg.datagram, "tunnstate") &&
            dg.datagram.tunnstate.channelId !== channelID))
      ) {
        KnxLog.get().trace(
          "*** Ignoring %s datagram for other channel (own: %d)",
          descr,
          channelID
        );
      } else {
        return dg;
      }
    } catch (err) {
      KnxLog.get().debug(
        "Incomplete/unparseable UDP packet: %s: %s",
        err,
        msg.toString("hex")
      );
    }

    return null;
  }
}

module.exports = KnxDatagram;
