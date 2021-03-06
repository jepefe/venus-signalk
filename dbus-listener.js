const dbus = require('dbus-native')
const debug = require('debug')('vedirect:dbus')
const _ = require('lodash')

module.exports = function (messageCallback, address) {
  var bus
  if (address) {
    bus = dbus.createClient({
      busAddress: address,
      authMethods: ['ANONYMOUS']
    })
  } else {
    bus = process.env.DBUS_SESSION_BUS_ADDRESS ? dbus.sessionBus() : dbus.systemBus()
  }

  if (!bus) {
    throw new Error('Could not connect to the D-Bus')
  }

  // name owner (:0132 for example) is the key. In signals this is the sender
  // service name (com.victronenergy.battery.ttyO1) is the value
  var services = {}

  // get info on all existing D-Bus services at startup
  bus.listNames((props, args) => {
    args.forEach(name => {
      if ( name.startsWith('com.victronenergy') ) {
        bus.getNameOwner(name, (props, args) => {
        initService(args, name)
        })
      }
    })
  })

  function initService(owner, name) {
    var service = { name: name }
    services[owner] = service

    debug(`${name} is sender ${owner}`)

    bus.invoke({
      path: '/DeviceInstance',
      destination: name,
      interface: 'com.victronenergy.BusItem',
      member: "GetValue"
    }, function(err, res) {
      if ( err ) {
        // There are several dbus services that don't have the /DeviceInstance
        // path. They are services that are not interesting for signalk, like
        // a process to manage settings on the dbus, the logger to VRM Portal
        // and others. All services that send out data for connected devices do
        // have the /DeviceInstance path.
        debug(`warning: error getting device instance for ${name}`)
      } else {
        services[owner].deviceInstance = res[1][0];
      }
    })

    bus.invoke({
      path: '/',
      destination: name,
      interface: 'com.victronenergy.BusItem',
      member: "GetValue"
    }, function(err, res) {
      if ( err ) {
        // Some services don't support requesting the root path. They are not
        // interesting to signalk, see above in the comments on /DeviceInstance
        debug(`warning: error during GetValue on / for ${name}`)
      } else {
        var data = {};
        res[1][0].forEach(kp => {
          data[kp[0]] = kp[1][1][0];
        })

        service.deviceInstance = data.DeviceInstance;

        if ( !_.isUndefined(data.FluidType) ) {
          service.fluidType = data.FluidType;
        }

        var messages = []
        _.keys(data).forEach(path => {
          messages.push({
            path: '/' + path,
            senderName: service.name,
            value: data[path],
            instanceName: service.deviceInstance,
            fluidType: service.fluidType
          })
        })
        messageCallback(messages)
      }
    })
  }

  function signal_receive (m) {
    if (
      m.interface == 'com.victronenergy.BusItem' &&
      m.member == 'PropertiesChanged'
    ) {
      properties_changed(m)
    } else if (
      m.interface == 'org.freedesktop.DBus' &&
      m.member == 'NameOwnerChanged'
    ) {
      name_owner_changed(m)
    }
  }

  function name_owner_changed (m) {
    name = m.body[0]
    old_owner = m.body[1]
    new_owner = m.body[2]

    if (name.startsWith('com.victronenergy')) {
      initService(new_owner, name)
    } else {
      delete services[old_owner]
    }
  }

  function properties_changed (m) {
    // Message contents:
    // { serial: 5192,
    //   path: '/Dc/0/Power',
    //   interface: 'com.victronenergy.BusItem',
    //   member: 'PropertiesChanged',
    //   signature: 'a{sv}',
    //   sender: ':1.104',
    //   type: 4,
    //   flags: 1,
    //   body: [ [ [Object], [Object] ] ]}

    m.body[0].forEach(entry => {
      if ( entry[0] == 'Text' ) {
        m.text = entry[1][1][0]
      } else if ( entry[0] == 'Value' ) {
        m.value = entry[1][1][0]
      } else if ( entry[0] == 'Valid' ) {
        //Ignoring Valid because it is deprecated
      }
    })

    var service = services[m.sender]

    if ( !service || !service.name || !service.deviceInstance) {
      // See comment above explaining why some services don't have the
      // /DeviceInstance path
      debug(`warning: unknown service; ${m.sender}`)
      return
    }

    m.senderName = service.name

    if (m.path == '/DeviceInstance') {
      services[m.sender].deviceInstance = m.value
      m.instanceName = m.value
    } else {
      m.instanceName = service.deviceInstance
    }

    //debug(`${m.sender}:${m.senderName}:${m.instanceName}: ${m.path} = ${m.value}`);
    messageCallback([m])
  }

  bus.connection.on('message', signal_receive)
  bus.addMatch(
    "type='signal',interface='com.victronenergy.BusItem',member='PropertiesChanged'",
    d => {}
  )
  bus.addMatch("type='signal',member='NameOwnerChanged'", d => {})

  // TODO return a function to stop the dbus listener
  return () => {
    bus.connection.end()
  }
}
