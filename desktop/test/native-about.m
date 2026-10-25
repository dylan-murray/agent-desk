// Test-only access to this process's own AppKit panel; no Accessibility permission.
#import <AppKit/AppKit.h>
#include <node_api.h>
#include <stdlib.h>

static NSString *Input(napi_env env, napi_value value) {
  size_t size = 0;
  napi_get_value_string_utf8(env, value, NULL, 0, &size);
  char *buffer = malloc(size + 1);
  napi_get_value_string_utf8(env, value, buffer, size + 1, &size);
  NSString *result = [[NSString alloc] initWithBytes:buffer length:size encoding:NSUTF8StringEncoding];
  free(buffer);
  return result;
}

static void Collect(NSView *view, NSMutableArray<NSString *> *texts) {
  if ([view isKindOfClass:NSTextField.class]) {
    NSString *text = [(NSTextField *)view stringValue];
    if (text.length) [texts addObject:text];
  } else if ([view isKindOfClass:NSTextView.class]) {
    NSString *text = [(NSTextView *)view string];
    if (text.length) [texts addObject:text];
  }
  for (NSView *child in view.subviews) Collect(child, texts);
}

static napi_value Inspect(napi_env env, napi_callback_info callback) {
  size_t count = 2;
  napi_value args[2];
  napi_get_cb_info(env, callback, &count, args, NULL, NULL);
  if (count != 2) {napi_throw_error(env, NULL, "Expected display text and screenshot path");return NULL;}
  NSString *expected = Input(env, args[0]);
  NSString *output = Input(env, args[1]);
  NSMutableArray<NSString *> *all = [NSMutableArray array];
  for (NSWindow *window in NSApp.windows) {
    if (!window.isVisible) continue;
    NSMutableArray<NSString *> *texts = [NSMutableArray array];
    Collect(window.contentView, texts);
    [all addObjectsFromArray:texts];
    if ([[texts componentsJoinedByString:@"\n"] containsString:expected]) {
      NSView *view = window.contentView;
      NSBitmapImageRep *bitmap = [view bitmapImageRepForCachingDisplayInRect:view.bounds];
      [view cacheDisplayInRect:view.bounds toBitmapImageRep:bitmap];
      // NSVisualEffectView's window background is transparent when cached offscreen.
      NSImage *snapshot = [[NSImage alloc] initWithSize:view.bounds.size];
      [snapshot lockFocus];
      [NSColor.windowBackgroundColor setFill];NSRectFill(NSMakeRect(0,0,view.bounds.size.width,view.bounds.size.height));
      NSImage *content = [[NSImage alloc] initWithCGImage:bitmap.CGImage size:view.bounds.size];
      [content drawAtPoint:NSZeroPoint fromRect:NSZeroRect operation:NSCompositingOperationSourceOver fraction:1];
      [snapshot unlockFocus];
      NSBitmapImageRep *opaque = [NSBitmapImageRep imageRepWithData:snapshot.TIFFRepresentation];
      NSData *png = [opaque representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
      [png writeToFile:output atomically:YES];
    }
  }
  napi_value result;
  napi_create_string_utf8(env, [all componentsJoinedByString:@"\n"].UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}

static napi_value Close(napi_env env, napi_callback_info callback) {
  for (NSWindow *window in NSApp.windows) {
    if ([NSStringFromClass(window.class) containsString:@"About"] || [window.title hasPrefix:@"About "]) [window orderOut:nil];
  }
  napi_value result;napi_get_undefined(env, &result);return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"inspect", NULL, Inspect, NULL, NULL, NULL, napi_default, NULL},
    {"close", NULL, Close, NULL, NULL, NULL, napi_default, NULL},
  };
  napi_define_properties(env, exports, 2, properties);
  return exports;
}
NAPI_MODULE(about_fixture, Init)
