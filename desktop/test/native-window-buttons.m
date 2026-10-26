// Inspect this fixture window's actual AppKit buttons without Accessibility access.
#import <AppKit/AppKit.h>
#include <node_api.h>
#include <string.h>

static napi_value Hidden(napi_env env, napi_callback_info callback) {
  size_t count = 1, size = 0;
  napi_value args[1];void *bytes = NULL, *handle = NULL;
  napi_get_cb_info(env, callback, &count, args, NULL, NULL);
  if (count != 1 || napi_get_buffer_info(env, args[0], &bytes, &size) != napi_ok || size != sizeof(handle)) {
    napi_throw_error(env, NULL, "Expected a native NSView handle");return NULL;
  }
  memcpy(&handle, bytes, sizeof(handle));
  NSWindow *window = ((__bridge NSView *)handle).window;
  if (!window) {napi_throw_error(env, NULL, "Fixture window is missing");return NULL;}
  NSWindowButton kinds[] = {NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton};
  napi_value result;napi_create_array_with_length(env, 3, &result);
  for (uint32_t index = 0; index < 3; index++) {
    NSButton *button = [window standardWindowButton:kinds[index]];
    napi_value hidden;napi_get_boolean(env, button.isHiddenOrHasHiddenAncestor, &hidden);
    napi_set_element(env, result, index, hidden);
  }
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor property = {"hidden", NULL, Hidden, NULL, NULL, NULL, napi_default, NULL};
  napi_define_properties(env, exports, 1, &property);return exports;
}
NAPI_MODULE(window_buttons_fixture, Init)
