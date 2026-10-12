/* Real X11 CLIPBOARD owner. Hold PNG SelectionRequests until a file handshake releases them. */
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>

static Display *display;
static Atom png, targets;
static unsigned char *bytes;
static long size;
static FILE *log_file;
static void reply(XSelectionRequestEvent request) {
    XEvent event = {0};
    Atom property = request.property ? request.property : request.target;
    event.xselection.type = SelectionNotify;
    event.xselection.display = request.display;
    event.xselection.requestor = request.requestor;
    event.xselection.selection = request.selection;
    event.xselection.target = request.target;
    event.xselection.time = request.time;
    event.xselection.property = property;
    if (request.target == targets) {
        Atom available[] = {targets, png};
        XChangeProperty(display, request.requestor, property, XA_ATOM, 32, PropModeReplace, (unsigned char *) available, 2);
    } else if (request.target == png) {
        XChangeProperty(display, request.requestor, property, png, 8, PropModeReplace, bytes, size);
        fprintf(log_file, "{\"action\":\"PNG SelectionNotify\",\"requestor\":%lu,\"bytes\":%ld}\n", request.requestor, size);
        fflush(log_file);
    } else event.xselection.property = None;
    XSendEvent(display, request.requestor, False, 0, &event);
    XFlush(display);
}
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    FILE *input = fopen(argv[1], "rb");
    if (!input) return 3;
    fseek(input, 0, SEEK_END); size = ftell(input); rewind(input);
    bytes = malloc(size); if (fread(bytes, 1, size, input) != (size_t)size) return 4;
    fclose(input);
    display = XOpenDisplay(NULL); if (!display) return 5;
    Window owner = XCreateSimpleWindow(display, DefaultRootWindow(display), 0, 0, 1, 1, 0, 0, 0);
    Atom clipboard = XInternAtom(display, "CLIPBOARD", False);
    targets = XInternAtom(display, "TARGETS", False); png = XInternAtom(display, "image/png", False);
    XSetSelectionOwner(display, clipboard, owner, CurrentTime); XSync(display, False);
    if (XGetSelectionOwner(display, clipboard) != owner) return 6;
    char ready[4096], arm[4096], requested[4096], release[4096], log_path[4096];
    snprintf(ready, sizeof(ready), "%s.ready", argv[2]); snprintf(arm, sizeof(arm), "%s.arm", argv[2]);
    snprintf(requested, sizeof(requested), "%s.requested", argv[2]); snprintf(release, sizeof(release), "%s.release", argv[2]);
    snprintf(log_path, sizeof(log_path), "%s.log", argv[2]); log_file = fopen(log_path, "w");
    FILE *marker = fopen(ready, "w"); fputs("owner ready", marker); fclose(marker);
    XSelectionRequestEvent pending[64]; int count = 0;
    while (1) {
        while (XPending(display)) {
            XEvent event; XNextEvent(display, &event);
            if (event.type == SelectionClear) return 7;
            if (event.type != SelectionRequest) continue;
            XSelectionRequestEvent request = event.xselectionrequest;
            if (request.target == png && access(arm, F_OK) == 0 && access(release, F_OK) != 0) {
                if (count == 64) return 8;
                pending[count++] = request;
                fprintf(log_file, "{\"action\":\"held PNG SelectionRequest\",\"requestor\":%lu}\n", request.requestor); fflush(log_file);
                marker = fopen(requested, "w"); fprintf(marker, "%d", count); fclose(marker);
            } else reply(request);
        }
        if (count && access(release, F_OK) == 0) {
            for (int i = 0; i < count; i++) reply(pending[i]);
            count = 0;
        }
        struct timespec delay = {0, 1000000}; nanosleep(&delay, NULL);
    }
}
