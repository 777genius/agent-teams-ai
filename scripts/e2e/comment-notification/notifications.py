#!/usr/bin/python3
"""Private test bus only: record the actual freedesktop Notification boundary."""
import json
import sys
import time

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
name = dbus.service.BusName('org.freedesktop.Notifications', bus)


class Notifications(dbus.service.Object):
    def __init__(self):
        super().__init__(bus, '/org/freedesktop/Notifications')
        self.sequence = 0

    @dbus.service.method('org.freedesktop.Notifications', in_signature='', out_signature='as')
    def GetCapabilities(self):
        return ['body', 'actions', 'persistence']

    @dbus.service.method('org.freedesktop.Notifications', in_signature='', out_signature='ssss')
    def GetServerInformation(self):
        return ('Comment notification TEST recorder', 'TEST', '1.0', '1.2')

    @dbus.service.method('org.freedesktop.Notifications', in_signature='susssasa{sv}i', out_signature='u')
    def Notify(self, app, replaces, icon, summary, body, actions, hints, timeout):
        self.sequence += 1
        with open(sys.argv[1], 'a', encoding='utf-8') as stream:
            stream.write(json.dumps({'id': self.sequence, 'at': time.time(), 'app': str(app),
                                     'summary': str(summary), 'body': str(body)}) + '\n')
        return self.sequence

    @dbus.service.method('org.freedesktop.Notifications', in_signature='u', out_signature='')
    def CloseNotification(self, notification_id):
        pass


service = Notifications()
print('READY', flush=True)
GLib.MainLoop().run()
