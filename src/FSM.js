const dgram = require("dgram");
const machina = require("machina");
const util = require("util");

const KnxConstants = require("./KnxConstants.js");
const KnxDatagram = require("./KnxDatagram.js");
const KnxLog = require("./KnxLog.js");

module.exports = machina.Fsm.extend({
  initialize: function (options) {
    this._options = Object.assign(
      {
        remoteEndpoint: null,
        physServerAddr: "1.1.220",
        twoLevelAddressing: false,
        // physServerAddr: "1.1.020",
        loglevel: "info",
      },
      options
    );

    this.log = KnxLog.get(options);

    this._connStateTimer = null;
    this._connStateRequestTimer = null;

    this._discoverSocket = null; // for discovery
    this._controlSocket = null; // for control
    this._dataSocket = null; // for tunnel requests

    this._channelID = null;
    this._connectionHeartbeatFailures = 0;

    this._inboundSeqNum = 0;
    this._outboundSeqNum = 0;

    this._remoteDiscoverEndpoint = {
      addr: null,
      port: null,
    };
    this._remoteControlEndpoint = {
      addr: null,
      port: null,
    };
    this._remoteDataEndpoint = {
      addr: null,
      port: null,
    };
  },

  namespace: "knxnet",

  initialState: "uninitialized",

  states: {
    uninitialized: {
      "*": function () {
        this.log.info("State %s", this.state);
        this.deferUntilTransition();
        this.transition("idle");
      },
    },

    idle: {
      _onEnter: function () {
        this.log.info("State %s", this.state);
        this.emit("offline");

        // kill control endpoint
        if (this._controlSocket) {
          this._controlSocket.close();
          this._controlSocket = null;
        }

        this._channelID = null;

        // wait => searching
        this.timer = setTimeout(() => {
          this.handle("startsearch");
        }, 2000);
      },
      startsearch: "searching",
      _onExit: function () {
        clearTimeout(this.timer);
      },
    },

    searching: {
      _onEnter: function () {
        this.log.info("State %s", this.state);

        this.timer = setTimeout(() => {
          this.handle("timeout");
        }, 15000);

        if (!this._options.remoteEndpoint) {
          this._startSearch();
        }
      },
      // create discovery/control endpoint
      // SEARCH_REQUEST
      inbound_SEARCH_RESPONSE: function (datagram) {
        this.log.info(
          "Got search response from %s (%s, %s, %s)",
          datagram.hpai.tunnelEndpoint,
          datagram.devinfo.physicalAddr,
          datagram.devinfo.serial,
          datagram.devinfo.name
        );
        if (
          !this._options.physServerAddr ||
          datagram.devinfo.physicalAddr === this._options.physServerAddr
        ) {
          this.log.notice(
            "Using device with physical address %s (%s, %s, %s)",
            datagram.devinfo.physicalAddr,
            datagram.hpai.tunnelEndpoint,
            datagram.devinfo.serial,
            datagram.devinfo.name
          );
          const ipinfo = datagram.hpai.tunnelEndpoint.split(":");
          this._remoteControlEndpoint = {
            addr: ipinfo[0],
            port: ipinfo[1],
          };
          this.log.trace("%s", this._remoteControlEndpoint);

          this.transition("connecting");
        } else {
          this.log.info(
            "Ignoring device with physical address %s (%s, %s, %s)",
            datagram.devinfo.physicalAddr,
            datagram.hpai.tunnelEndpoint,
            datagram.devinfo.serial,
            datagram.devinfo.name
          );
        }
      },
      timeout: "idle",
      _onExit: function () {
        clearTimeout(this.timer);
        if (this._discoverSocket) {
          this._discoverSocket.close();
          this._discoverSocket = null;
        }
      },
    },

    connecting: {
      _onEnter: function () {
        this.log.info("State %s", this.state);

        this.timer = setTimeout(() => {
          this.handle("timeout");
        }, 15000);

        this._startConnect();
      },

      disconnect: "disconnecting",

      inbound_CONNECT_RESPONSE(datagram) {
        this.log.info("got connect response");
        if (
          "connstate" in datagram &&
          datagram.connstate.status ===
            KnxConstants.RESPONSECODE.E_NO_MORE_CONNECTIONS
        ) {
          try {
            this.socket.close();
          } catch (error) {}
          this.transition("idle");
          this.log.warn(
            "The KNXnet/IP server rejected the data connection (Maximum connections reached)"
          );
        } else {
          // store channel ID into the Connection object
          this._channelID = datagram.connstate.channelId;
          this.transition("connected");
        }
      },

      timeout: "disconnecting",

      _onExit: function () {
        clearTimeout(this.timer);
      },

      // create data control endpoint
      // CONNECTION_REQUEST
    },

    connected: {
      _onEnter: function () {
        this.log.info("State %s", this.state);

        this._connectionHeartbeatFailures = 0;

        this._inboundSeqNum = 0;
        this._outboundSeqNum = 0;

        this._connStateRequestTimer = setInterval(() => {
          this.handle("outbound_CONNECTIONSTATE_REQUEST");
        }, 45000);

        this.emit("online");
        this.transition("online");
      },
      "*": function (data) {
        this.log.trace(
          "*** deferring %s until waittime is over",
          data.inputType
        );
        this.deferUntilTransition("online");
      },

      // onEnter => CONNECTIONSTATE_REQUEST timer
      //  => online
    },

    waiting: {
      _onEnter: function () {
        this.log.info("State %s", this.state);

        this.timer = setTimeout(() => {
          this.handle("timeout");
        }, 50);
      },

      "inbound_TUNNELING_REQUEST_L_Data.ind"(datagram) {
        this.transition("inbound_TUNNELING_REQUEST_L_Data", datagram);
      },

      disconnect: "disconnecting",
      timeout: "online",
      _onExit: function () {
        clearTimeout(this.timer);
      },
      "*": function (data) {
        this.log.trace(
          "*** deferring %s until waittime is over",
          data.inputType
        );
        this.deferUntilTransition("online");
      },
    },

    online: {
      _onEnter: function () {
        this.log.info("State %s", this.state);
      },
      disconnect: "disconnecting",
      inbound_DISCONNECT_REQUEST(datagram) {
        //        let dg = this.prepareDatagram(
        //        KnxConstants.SERVICE_TYPE.DISCONNECT_RESPONSE
        //    );
        //  this.send(this._controlSocket, this._remoteControlEndpoint, dg);
        clearInterval(this._connStateRequestTimer);
        this.transition("idle");
      },
      "inbound_TUNNELING_REQUEST_L_Data.con"(datagram) {
        this.transition("inbound_TUNNELING_REQUEST_L_Data", datagram);
      },
      "inbound_TUNNELING_REQUEST_L_Data.ind"(datagram) {
        this.transition("inbound_TUNNELING_REQUEST_L_Data", datagram);
      },
      outbound_CONNECTIONSTATE_REQUEST: "outbound_CONNECTIONSTATE_REQUEST",
      outbound_TUNNELING_REQUEST(datagram) {
        this.transition("outbound_TUNNELING_REQUEST", datagram);
      },
    },

    inbound_TUNNELING_REQUEST_L_Data: {
      _onEnter: function (datagram) {
        this.log.info("State %s", this.state);
        if (
          datagram.tunnstate.seqnum === this._inboundSeqNum ||
          datagram.tunnstate.seqnum === (this._inboundSeqNum + 255) % 256
        ) {
          const ack = this._prepareKnxDatagram(
            KnxConstants.SERVICE_TYPE.TUNNELING_ACK,
            datagram
          );
          /* acknowledge by copying the inbound datagram's sequence counter */
          ack.setSeqNum(datagram.tunnstate.seqnum);
          ack.send(
            this._controlSocket,
            this._remoteControlEndpoint,
            ack,
            (err) => {
              this.log.warn("Error while sending ACK: %s", err);
            }
          );

          if (datagram.tunnstate.seqnum === this._inboundSeqNum) {
            this._inboundSeqNum = (this._inboundSeqNum + 1) % 256;

            const evtName = datagram.cemi.apdu.apci;
            const destAddr = datagram.cemi.destAddr;
            this.log.info("Got event %s for %s", evtName, destAddr);

            this.emit(
              util.format("%s_%s", evtName, destAddr),
              datagram.cemi.srcAddr,
              datagram.cemi.apdu.data
            );
            this.emit(
              util.format("event_%s", destAddr),
              evtName,
              datagram.cemi.srcAddr,
              datagram.cemi.apdu.data
            );

            this.emit(
              "event",
              evtName,
              datagram.cemi.srcAddr,
              datagram.cemi.destAddr,
              datagram.cemi.apdu.data
            );
          }
        } else {
          // IGNORE
          this.log.warn(
            "Unexpected seqnum received (%d), expected %d",
            datagram.tunnstate.seqnum,
            this._inboundSeqNum
          );
        }
        this.transition("waiting");
      },
      "*": function (data) {
        this.log.trace(
          "*** deferring %s until done with inbound request",
          data.inputType
        );
        this.deferUntilTransition();
      },
    },

    outbound_CONNECTIONSTATE_REQUEST: {
      _onEnter: function () {
        this.log.info("State %s", this.state);
        this.handle("send_CONNECTIONSTATE_REQUEST");
      },

      send_CONNECTIONSTATE_REQUEST() {
        this.log.trace("CONNECTIONSTATE =>>");

        this._connStateTimer = setTimeout(() => {
          this.handle("inbound_CONNECTIONSTATE_RESPONSE", null);
        }, 10000);

        const dg = this._prepareKnxDatagram(
          KnxConstants.SERVICE_TYPE.CONNECTIONSTATE_REQUEST
        );
        dg.send(this._controlSocket, this._remoteControlEndpoint);
      },

      inbound_CONNECTIONSTATE_RESPONSE(datagram) {
        clearTimeout(this._connStateTimer);
        if (datagram === null) {
          this.log.warn("Connstate response timeout");
          this._connectionHeartbeatFailures++;
        } else {
          const responseCode = KnxConstants.keyText(
            "RESPONSECODE",
            datagram.connstate.status
          );
          if (responseCode === "NO_ERROR") {
            this.log.trace("No error");
            this._connectionHeartbeatFailures = 0;
            this.handle("ok");
            return;
          } else {
            this.log.warn("Connstate response: %s", responseCode);
            this._connectionHeartbeatFailures++;
          }
        }
        if (this._connectionHeartbeatFailures > 3) {
          this.transition("disconnecting");
        }
        setImmediate(() => {
          this.handle("send_CONNECTIONSTATE_REQUEST");
        });
      },
      ok: "waiting",
      "*": function (data) {
        this.log.trace(
          "*** deferring %s until done with connectionstate request",
          data.inputType
        );
        this.deferUntilTransition();
      },

      _onExit: function () {
        clearTimeout(this._connStateTimer);
      },
    },

    outbound_TUNNELING_REQUEST: {
      _onEnter: function (datagram) {
        this.log.info("State %s", this.state);

        datagram.setSeqNum(this._outboundSeqNum);

        this._outboundDatagram = datagram;
        this._outboundFailures = 0;

        this.handle("send_TUNNELING_REQUEST");
      },

      send_TUNNELING_REQUEST() {
        this.log.trace("TUNNELING_REQUEST =>>");

        this._ackTimer = setTimeout(() => {
          this.handle("inbound_TUNNELING_ACK", null);
        }, 1000);

        this._outboundDatagram.send(
          this._controlSocket,
          this._remoteControlEndpoint
        );
      },

      inbound_TUNNELING_ACK(datagram) {
        let responseCode = null;
        if (datagram === null) {
          this.log.warn("ACK timeout");
          this._outboundFailures++;
        } else {
          this.log.trace("got ack");

          const seqnum = datagram.tunnstate.seqnum;

          if (seqnum === this._outboundSeqNum) {
            this.log.info("Got expected ack (%d)", seqnum);

            clearTimeout(this._ackTimer);

            responseCode = KnxConstants.keyText(
              "RESPONSECODE",
              datagram.tunnstate.status
            );
            if (responseCode === "NO_ERROR") {
              this.log.trace("No error");

              this._outboundSeqNum = (this._outboundSeqNum + 1) % 256;

              this.emit(
                util.format("ReceivedAck_%s", this._outboundDatagram.uuid),
                responseCode
              );

              this.handle("ok");
              return;
            }
            this.log.warn("ACK has error condition %s", responseCode);
            this._outboundFailures++;
          } else {
            this.log.warn(
              "Received unexpected ack (got %d, expected %d)",
              seqnum,
              this._outboundSeqNum
            );
            // FIXME: ignore?
            return;
          }
        }
        if (this._outboundFailures > 1) {
          this.emit(
            util.format("ReceivedAck_%s", this._outboundDatagram.uuid),
            responseCode
          );

          this.log.warn("ACK errors, disconnecting");
          this.transition("disconnecting");
          return;
        }
        setImmediate(() => {
          this.handle("send_TUNNELING_REQUEST");
        });
      },
      ok: "waiting",
      "*": function (data) {
        this.log.trace(
          "*** deferring %s until done with tunneling request",
          data.inputType
        );
        this.deferUntilTransition();
      },

      _onExit: function () {
        clearTimeout(this._ackTimer);

        this._outboundDatagram = null;
        this._outboundFailures = 0;
      },
    },

    disconnecting: {
      _onEnter: function () {
        // purge all pending requests when we want to disconnect
        this.clearQueue();
        this.log.info("State %s", this.state);
        clearInterval(this._connStateRequestTimer);

        this.timer = setTimeout(() => {
          this.handle("timeout");
        }, 10000);

        const dg = this._prepareKnxDatagram(
          KnxConstants.SERVICE_TYPE.DISCONNECT_REQUEST
        );
        dg.send(this._controlSocket, this._remoteControlEndpoint);
      },
      inbound_DISCONNECT_RESPONSE(datagram) {
        this.transition("idle");
      },
      timeout: "idle",
      _onExit: function () {
        clearTimeout(this.timer);
      },
    },
  },

  _startSearch: function () {
    this._remoteDiscoverEndpoint.addr = "224.0.23.12";
    this._remoteDiscoverEndpoint.port = 3671;

    const socket = dgram.createSocket({
      type: "udp4",
      reuseAddr: true,
    });

    socket.on("error", () => {
      this.log.warn("search socket error => idle?");
    });
    socket.on("listening", () => {
      socket.addMembership("224.0.23.12");
    });
    socket.on("message", (msg, rinfo, callback) => {
      this.log.info(
        "Inbound multicast message from " +
          rinfo.address +
          ": " +
          msg.toString("hex")
      );
      const response = KnxDatagram.parseKnxMessage(
        this._channelID,
        msg,
        rinfo,
        this._options,
        callback
      );
      if (response !== null) {
        this.log.trace("%j", response.datagram);

        if (response.datagram.hpai.tunnelEndpoint === "0.0.0.0:0") {
          response.datagram.hpai.tunnelEndpoint = util.format(
            "%s:%s",
            rinfo.address,
            rinfo.port
          );
        }

        this.handle("inbound_" + response.datagramDesc(), response.datagram);
      }
    });
    socket.bind();
    this._discoverSocket = socket;

    const dg = this._prepareKnxDatagram(
      KnxConstants.SERVICE_TYPE.SEARCH_REQUEST
    );
    this.log.trace("%j", dg.datagram);
    dg.send(this._discoverSocket, this._remoteDiscoverEndpoint);
  },

  _prepareKnxDatagram: function (svcType) {
    const dg = KnxDatagram.fromServiceRequest(
      svcType,
      this._options,
      this._remoteControlEndpoint,
      this._channelID
    );
    return dg;
  },

  _startConnect: function () {
    const socket = dgram.createSocket({
      type: "udp4",
      reuseAddr: true,
    });

    socket.on("error", () => {
      this.log.warn("control socket error => idle?");
    });
    socket.on("message", (msg, rinfo, callback) => {
      this.log.trace(
        "Inbound control message from " +
          rinfo.address +
          ": " +
          msg.toString("hex")
      );
      const dg = KnxDatagram.parseKnxMessage(
        this._channelID,
        msg,
        rinfo,
        this._options,
        callback
      );

      if (dg !== null) {
        const signal = util.format("inbound_%s", dg.datagramDesc());
        if (dg.datagramDesc() === "DISCONNECT_REQUEST") {
          this.log.info("empty internal fsm queue due to %s: ", signal);
          this.clearQueue();
        }
        this.handle(signal, dg.datagram);
      }
    });
    socket.bind();
    this._controlSocket = socket;

    const dg = this._prepareKnxDatagram(
      KnxConstants.SERVICE_TYPE.CONNECT_REQUEST
    );
    this.log.trace("%j", dg);
    dg.send(this._controlSocket, this._remoteControlEndpoint);
  },

  connect: function () {
    this.handle("startsearch");
  },

  disconnect: function () {
    this.handle("disconnect");
  },

  queueRequest: function (ev, data) {
    this.handle(ev, data);
  },

  read: function (groupAddress, maxTimeout = 5000) {
    const dg = this._prepareKnxDatagram(
      KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST
    );

    const resultPromise = new Promise((resolve, reject) => {
      const responseEvent = util.format("GroupValue_Response_%s", groupAddress);

      let timeout = null;

      const eventHandler = (src, data) => {
        this.log.trace("Handle event %s (%j)", src, data);
        this.off(responseEvent, eventHandler);
        clearTimeout(timeout);
        if (src === null) {
          reject(new Error("No response"));
        } else if (data === null) {
          reject(new Error("Invalid response"));
        } else {
          resolve(data);
        }
      };

      this.on(responseEvent, eventHandler);

      timeout = setTimeout(() => {
        eventHandler(null);
      }, maxTimeout);
    });
    dg.makeReadRequest(groupAddress);
    this.queueRequest("outbound_" + dg.getServiceType(), dg);

    return resultPromise;
  },

  readAsync: function (groupAddress, maxTimeout = 5000) {
    const dg = this._prepareKnxDatagram(
      KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST
    );

    const resultPromise = new Promise((resolve, reject) => {
      const responseEvent = util.format("ReceivedAck_%s", dg.uuid);

      let timeout = null;

      const eventHandler = (response) => {
        this.log.trace("Handle event %s", response);
        this.off(responseEvent, eventHandler);
        clearTimeout(timeout);
        if (response === null) {
          reject(new Error("No response"));
        } else if (response !== "NO_ERROR") {
          reject(new Error(response));
        } else {
          resolve(true);
        }
      };

      this.on(responseEvent, eventHandler);

      timeout = setTimeout(() => {
        eventHandler(null);
      }, maxTimeout);
    });
    dg.makeReadRequest(groupAddress);
    this.queueRequest("outbound_" + dg.getServiceType(), dg);

    return resultPromise;
  },

  write: function (groupAddress, value, dpt, maxTimeout = 5000) {
    const dg = this._prepareKnxDatagram(
      KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST
    );

    const resultPromise = new Promise((resolve, reject) => {
      const responseEvent = util.format("ReceivedAck_%s", dg.uuid);

      let timeout = null;

      const eventHandler = (response) => {
        this.log.trace("Handle event %s", response);
        this.off(responseEvent, eventHandler);
        clearTimeout(timeout);
        if (response === null) {
          reject(new Error("No response"));
        } else if (response !== "NO_ERROR") {
          reject(new Error(response));
        } else {
          resolve(true);
        }
      };

      this.on(responseEvent, eventHandler);

      timeout = setTimeout(() => {
        eventHandler(null);
      }, maxTimeout);
    });

    dg.makeWriteRequest(groupAddress, value, dpt);
    this.queueRequest("outbound_" + dg.getServiceType(), dg);

    return resultPromise;
  },

  writeRaw: function (groupAddress, value, bitlength, maxTimeout = 5000) {
    const dg = this._prepareKnxDatagram(
      KnxConstants.SERVICE_TYPE.TUNNELING_REQUEST
    );

    const resultPromise = new Promise((resolve, reject) => {
      const responseEvent = util.format("ReceivedAck_%s", dg.uuid);

      let timeout = null;

      const eventHandler = (response) => {
        this.log.trace("Handle event %s", response);
        this.off(responseEvent, eventHandler);
        clearTimeout(timeout);
        if (response === null) {
          reject(new Error("No response"));
        } else if (response !== "NO_ERROR") {
          reject(new Error(response));
        } else {
          resolve(true);
        }
      };

      this.on(responseEvent, eventHandler);

      timeout = setTimeout(() => {
        eventHandler(null);
      }, maxTimeout);
    });

    dg.makeWriteRawRequest(groupAddress, value, bitlength);
    this.queueRequest("outbound_" + dg.getServiceType(), dg);

    return resultPromise;
  },
});
