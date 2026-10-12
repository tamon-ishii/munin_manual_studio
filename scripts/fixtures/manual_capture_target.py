#!/usr/bin/python3
"""Deterministic GTK target for native capture tests; no external application."""
import argparse
import json
from pathlib import Path
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

parser = argparse.ArgumentParser()
parser.add_argument('--arguments-output', required=True)
parser.add_argument('values', nargs='*')
args = parser.parse_args()
Path(args.arguments_output).write_text(json.dumps(args.values))
window = Gtk.Window(title='Munin Workflow Fixture')
window.set_default_size(640, 400)
layout = Gtk.Fixed()
button = Gtk.Button(label='Save fixture')
button.set_size_request(120, 80)
button.connect('clicked', lambda _: button.set_label('Saved fixture'))
layout.put(button, 30, 40)
window.add(layout)
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
