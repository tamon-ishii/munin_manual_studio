"""Owned-process AT-SPI driver. Physical input requires the owned window in front."""
import ctypes
import subprocess
import time
from pathlib import Path
import gi
gi.require_version('Atspi', '2.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Atspi, Gdk


class NativeUI:
    def __init__(self, pid):
        self.pid = pid
        self.log = []
        self.x = ctypes.CDLL('libX11.so.6')
        self.t = ctypes.CDLL('libXtst.so.6')
        self.x.XOpenDisplay.restype = ctypes.c_void_p
        self.display = self.x.XOpenDisplay(None)
        if not self.display:
            raise RuntimeError('X11 display unavailable')
        self.x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        self.x.XKeysymToKeycode.restype = ctypes.c_uint
        self.x.XkbKeycodeToKeysym.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_int]
        self.x.XkbKeycodeToKeysym.restype = ctypes.c_ulong
        self.x.XFlush.argtypes = [ctypes.c_void_p]
        self.t.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        self.t.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
        self.t.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

    def owned(self, pid):
        return self.belongs(pid, self.pid)

    @staticmethod
    def belongs(pid, owner):
        for _ in range(32):
            if pid == owner:
                return True
            try:
                pid = int(Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[1])
            except OSError:
                return False
        return False

    def nodes(self, node, depth=0):
        if node is None or depth > 28:
            return
        yield node
        try:
            for i in range(min(node.get_child_count(), 250)):
                yield from self.nodes(node.get_child_at_index(i), depth + 1)
        except Exception:
            pass

    def allnodes(self, owner=None):
        desktop = Atspi.get_desktop(0)
        for i in range(desktop.get_child_count()):
            try:
                app = desktop.get_child_at_index(i)
                pid = app.get_process_id() if app else None
            except Exception:
                # AT-SPI keeps application nodes briefly after their process exits.
                continue
            if app and self.belongs(pid, owner or self.pid):
                yield from self.nodes(app)

    def window_pid(self, content_pid):
        candidates = []
        for line in subprocess.check_output(['wmctrl', '-lp'], text=True).splitlines():
            columns = line.split(None, 4)
            if len(columns) >= 5 and columns[2].isdigit():
                pid = int(columns[2])
                if self.owned(pid) and self.belongs(content_pid, pid):
                    candidates.append(pid)
        # MarkIts is a child of Studio, so choose the closest window owner.
        for pid in candidates:
            if not any(other != pid and self.belongs(other, pid) for other in candidates):
                return pid
        raise RuntimeError('No owned window for accessible content')

    def find(self, name, role=None, owner=None, timeout=15, showing=True, prefix=False, enabled=False):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            matches = []
            for node in self.allnodes(owner):
                try:
                    text = self.text(node)
                    role_matches = (node.get_role_name() in role) if isinstance(role, (tuple, list, set)) else (not role or node.get_role_name() == role)
                    if (text.startswith(name) if prefix else text == name) and role_matches and (not showing or node.get_state_set().contains(Atspi.StateType.SHOWING)) and (not enabled or node.get_state_set().contains(Atspi.StateType.ENABLED)):
                        matches.append(node)
                except Exception:
                    pass
            if matches:
                return matches[-1]
            time.sleep(.15)
        raise RuntimeError(f'Owned UI control not found: {name} ({role})')

    @staticmethod
    def text(node):
        if node is None:
            return ''
        try:
            name = node.get_name()
        except Exception:
            return ''
        if name:
            return name
        try:
            if 'Text' not in node.get_interfaces():
                return ''
            return Atspi.Text.get_text(node, 0, -1)
        except Exception:
            return ''

    def source_editor(self, owner=None):
        # Ubuntu 22.04 WebKit exposes the source textarea as "embedded";
        # newer WebKit versions expose it as "entry" or "text".
        node = self.find('Markdown原稿', ('entry', 'text', 'embedded'), owner)
        assert 'Text' in node.get_interfaces(), 'Source editor must expose text and caret'
        assert node.get_state_set().contains(Atspi.StateType.EDITABLE), 'Source editor must be editable'
        self.log.append({'action': 'find source editor', 'role': node.get_role_name(), 'pid': node.get_process_id()})
        return node

    def front(self, pid):
        assert self.owned(pid), 'Cannot foreground unrelated process'
        for line in subprocess.check_output(['wmctrl', '-lp'], text=True).splitlines():
            columns = line.split(None, 4)
            if len(columns) >= 5 and columns[2] == str(pid):
                subprocess.run(['wmctrl', '-ia', columns[0]], check=True)
                for _ in range(20):
                    active = subprocess.check_output(['xprop', '-root', '_NET_ACTIVE_WINDOW'], text=True).split()[-1]
                    prop = subprocess.check_output(['xprop', '-id', active, '_NET_WM_PID'], text=True)
                    if prop.strip().split()[-1] == str(pid):
                        time.sleep(.15)
                        return
                    time.sleep(.1)
        raise RuntimeError(f'Owned window cannot receive physical input: {pid}')

    def click(self, name, role='push button', owner=None):
        node = self.find(name, role, owner, showing=False)
        try:
            node.get_component_iface().scroll_to(Atspi.ScrollType.ANYWHERE)
        except Exception:
            pass
        node = self.find(name, role, owner, enabled=True)
        pid = node.get_process_id()
        assert node.get_state_set().contains(Atspi.StateType.ENABLED), f'Disabled: {name}'
        assert node.get_action_iface().do_action(0), f'Action failed: {name}'
        self.log.append({'action': 'click', 'name': name, 'pid': pid})
        time.sleep(.25)

    def key(self, symbol, down):
        code = self.x.XKeysymToKeycode(self.display, symbol)
        assert code, f'No X11 key for {symbol}'
        self.t.XTestFakeKeyEvent(self.display, code, int(down), 0)

    def fill(self, name, value, owner=None):
        owner = owner or self.pid
        self.front(owner)
        text_roles = ('entry', 'text', 'page', 'embedded')
        node = self.find(name, text_roles, owner, showing=False)
        node.get_component_iface().scroll_to(Atspi.ScrollType.ANYWHERE)
        node = self.find(name, text_roles, owner)
        box = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        self.t.XTestFakeMotionEvent(self.display, -1, box.x + box.width // 2, box.y + box.height // 2, 0)
        self.t.XTestFakeButtonEvent(self.display, 1, 1, 0)
        self.t.XTestFakeButtonEvent(self.display, 1, 0, 0)
        self.x.XFlush(self.display)
        try:
            node.get_component_iface().grab_focus()
        except Exception:
            pass
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not node.get_state_set().contains(Atspi.StateType.FOCUSED):
            time.sleep(.05)
        has_text = 'Text' in node.get_interfaces()
        previous = Atspi.Text.get_text(node, 0, -1) if has_text else ''
        for symbol, down in [(65507, True), (ord('a'), True), (ord('a'), False), (65507, False)]:
            self.key(symbol, down)
        self.x.XFlush(self.display)
        def selected_all():
            if not previous or not has_text:
                return True
            if Atspi.Text.get_n_selections(node) < 1:
                return False
            selection = Atspi.Text.get_selection(node, 0)
            return selection.start_offset == 0 and selection.end_offset == len(previous)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and not selected_all():
            time.sleep(.05)
        for char in value:
            symbol = ord(char)
            code = self.x.XKeysymToKeycode(self.display, symbol)
            shifted = self.x.XkbKeycodeToKeysym(self.display, code, 0, 0) != symbol
            if shifted:
                assert self.x.XkbKeycodeToKeysym(self.display, code, 0, 1) == symbol
                self.key(65505, True)
            self.key(symbol, True)
            self.key(symbol, False)
            if shifted:
                self.key(65505, False)
            self.x.XFlush(self.display)
            time.sleep(.04)
        if has_text:
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline and Atspi.Text.get_text(node, 0, -1) != value:
                time.sleep(.1)
            assert Atspi.Text.get_text(node, 0, -1) == value, f'Input did not receive exact value: {name}'
        self.log.append({'action': 'fill', 'name': name, 'value': value})
        time.sleep(.3)

    def rectangle(self, pid, bounds=(.45, .45, .65, .65)):
        self.front(pid)
        self.click('⬜ 矩形', owner=pid)
        node = self.find('Background Canvas', 'image', pid)
        box = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        assert box.width > 100 and box.height > 100
        start = (box.x + int(box.width * bounds[0]), box.y + int(box.height * bounds[1]))
        end = (box.x + int(box.width * bounds[2]), box.y + int(box.height * bounds[3]))
        self.t.XTestFakeMotionEvent(self.display, -1, *start, 0)
        self.t.XTestFakeButtonEvent(self.display, 1, 1, 0)
        self.x.XFlush(self.display)
        time.sleep(.1)
        for index in range(1, 11):
            pos = [int(start[j] + (end[j] - start[j]) * index / 10) for j in range(2)]
            self.t.XTestFakeMotionEvent(self.display, -1, *pos, 0)
            self.x.XFlush(self.display)
            time.sleep(.025)
        self.t.XTestFakeButtonEvent(self.display, 1, 0, 0)
        self.x.XFlush(self.display)
        self.log.append({'action': 'draw rectangle', 'pid': pid})
        time.sleep(.3)

    def screenshot(self, pid, destination):
        self.front(pid)
        frame = next(node for node in self.allnodes(pid) if node.get_role_name() == 'frame')
        box = frame.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        window = Gdk.get_default_root_window()
        pixbuf = Gdk.pixbuf_get_from_window(window, box.x, box.y, box.width, box.height)
        assert pixbuf, 'Window screenshot failed'
        pixbuf.savev(str(destination), 'png', [], [])

    def document_image(self, name, container, showing=True):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            for node in self.allnodes(self.pid):
                if self.text(node) != name or node.get_role_name() != 'image':
                    continue
                ancestor = node.get_parent()
                for _ in range(30):
                    if not ancestor:
                        break
                    if self.text(ancestor) == container:
                        if not showing or node.get_state_set().contains(Atspi.StateType.SHOWING):
                            return node
                        break
                    ancestor = ancestor.get_parent()
            time.sleep(.15)
        raise RuntimeError(f'Manuscript image not found in {container}: {name}')

    def image_pixels(self, name, destination=None):
        self.front(self.pid)
        node = self.document_image(name, 'Markdownプレビュー', showing=False)
        node.get_component_iface().scroll_to(Atspi.ScrollType.ANYWHERE)
        node = self.document_image(name, 'Markdownプレビュー')
        box = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        window = Gdk.get_default_root_window()
        x, y = max(0, box.x), max(0, box.y)
        width, height = min(box.x + box.width, window.get_width()) - x, min(box.y + box.height, window.get_height()) - y
        assert width > 100 and height > 100, 'Document image must be visibly inspectable'
        pixbuf = Gdk.pixbuf_get_from_window(window, x, y, width, height)
        if destination:
            pixbuf.savev(str(destination), 'png', [], [])
        pixels, stride, channels = pixbuf.get_pixels(), pixbuf.get_rowstride(), pixbuf.get_n_channels()
        return sum(1 for row in range(height) for col in range(width) if pixels[row * stride + col * channels] < 180 and pixels[row * stride + col * channels + 1] < 180)

    def hover_image(self, name):
        self.front(self.pid)
        node = self.document_image(name, 'Markdown原稿', showing=False)
        node.get_component_iface().scroll_to(Atspi.ScrollType.ANYWHERE)
        node = self.document_image(name, 'Markdown原稿')
        box = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        self.t.XTestFakeMotionEvent(self.display, -1, box.x + box.width // 2, box.y + min(box.height // 2, 100), 0)
        self.x.XFlush(self.display)
        time.sleep(.5)

    def dump(self):
        result = []
        for node in self.allnodes():
            try:
                if node.get_state_set().contains(Atspi.StateType.SHOWING):
                    result.append([node.get_process_id(), node.get_role_name(), self.text(node)[:160]])
            except Exception:
                pass
        return result
