#include <emscripten.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <SDL2/SDL.h>
#include "lvgl.h"

static lv_display_t *display;
static lv_obj_t *screen_root;

typedef struct registered_font_t {
    char *id;
    lv_font_t *font;
    void *data;
    int primary;
    struct registered_font_t *next;
} registered_font_t;

static registered_font_t *registered_fonts;

typedef struct registered_image_t {
    char *id;
    lv_image_dsc_t descriptor;
    void *data;
    struct registered_image_t *next;
} registered_image_t;

static registered_image_t *registered_images;

static lv_color_t color_from_hex(int value) {
    return lv_color_hex((uint32_t)value);
}

static lv_coord_t size_from_text(const char *value, int fallback) {
    if (!value || !value[0]) return fallback;
    size_t length = strlen(value);
    if (length > 1 && value[length - 1] == '%') return lv_pct(atoi(value));
    return atoi(value);
}

static lv_align_t align_from_text(const char *value) {
    if (!value) return LV_ALIGN_DEFAULT;
    if (!strcmp(value, "center")) return LV_ALIGN_CENTER;
    if (!strcmp(value, "top_left")) return LV_ALIGN_TOP_LEFT;
    if (!strcmp(value, "top_mid")) return LV_ALIGN_TOP_MID;
    if (!strcmp(value, "top_right")) return LV_ALIGN_TOP_RIGHT;
    if (!strcmp(value, "left_mid")) return LV_ALIGN_LEFT_MID;
    if (!strcmp(value, "right_mid")) return LV_ALIGN_RIGHT_MID;
    if (!strcmp(value, "bottom_left")) return LV_ALIGN_BOTTOM_LEFT;
    if (!strcmp(value, "bottom_mid")) return LV_ALIGN_BOTTOM_MID;
    if (!strcmp(value, "bottom_right")) return LV_ALIGN_BOTTOM_RIGHT;
    return LV_ALIGN_DEFAULT;
}

static const lv_font_t *font_from_config(const char *font_id, int size) {
    if (font_id && font_id[0]) {
        registered_font_t *entry = registered_fonts;
        while (entry) {
            if (entry->primary && !strcmp(entry->id, font_id)) return entry->font;
            entry = entry->next;
        }
    }
    if (size >= 42) return &lv_font_montserrat_48;
    if (size >= 30) return &lv_font_montserrat_36;
    if (size >= 20) return &lv_font_montserrat_24;
    return LV_FONT_DEFAULT;
}

EMSCRIPTEN_KEEPALIVE
void lvgl_bridge_clear_fonts(void) {
    registered_font_t *entry = registered_fonts;
    while (entry) {
        registered_font_t *next = entry->next;
        lv_tiny_ttf_destroy(entry->font);
        free(entry->data);
        free(entry->id);
        free(entry);
        entry = next;
    }
    registered_fonts = NULL;
}

EMSCRIPTEN_KEEPALIVE
int lvgl_bridge_register_font(const char *id, void *data, int data_size, int font_size, int fallback) {
    if (!id || !id[0] || !data || data_size <= 0 || font_size <= 0) return 0;
    lv_font_t *font = lv_tiny_ttf_create_data(data, (size_t)data_size, font_size);
    if (!font) return 0;
    if (fallback) {
        registered_font_t *entry = registered_fonts;
        while (entry && (!entry->primary || strcmp(entry->id, id))) entry = entry->next;
        if (!entry) {
            lv_tiny_ttf_destroy(font);
            return 0;
        }
        lv_font_t *tail = entry->font;
        while (tail->fallback) tail = (lv_font_t *)tail->fallback;
        tail->fallback = font;
    }
    registered_font_t *entry = malloc(sizeof(registered_font_t));
    if (!entry) {
        lv_tiny_ttf_destroy(font);
        return 0;
    }
    entry->id = strdup(id);
    entry->font = font;
    entry->data = data;
    entry->primary = !fallback;
    entry->next = registered_fonts;
    registered_fonts = entry;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
void lvgl_bridge_clear_images(void) {
    registered_image_t *entry = registered_images;
    while (entry) {
        registered_image_t *next = entry->next;
        free(entry->data);
        free(entry->id);
        free(entry);
        entry = next;
    }
    registered_images = NULL;
}

EMSCRIPTEN_KEEPALIVE
int lvgl_bridge_register_image(const char *id, void *data, int data_size, int width, int height) {
    if (!id || !id[0] || !data || data_size <= 0 || width <= 0 || height <= 0) return 0;
    registered_image_t *entry = calloc(1, sizeof(registered_image_t));
    if (!entry) return 0;
    entry->id = strdup(id);
    entry->data = data;
    entry->descriptor.header.magic = LV_IMAGE_HEADER_MAGIC;
    entry->descriptor.header.cf = LV_COLOR_FORMAT_ARGB8888;
    entry->descriptor.header.w = width;
    entry->descriptor.header.h = height;
    entry->descriptor.header.stride = width * 4;
    entry->descriptor.data_size = (uint32_t)data_size;
    entry->descriptor.data = data;
    entry->next = registered_images;
    registered_images = entry;
    return 1;
}

static void render_tick(void) {
    lv_timer_handler();
}

EMSCRIPTEN_KEEPALIVE
int lvgl_bridge_init(int width, int height) {
    SDL_SetHint(SDL_HINT_EMSCRIPTEN_KEYBOARD_ELEMENT, "#lvgl-canvas");
    lv_init();
    display = lv_sdl_window_create(width > 0 ? width : 480, height > 0 ? height : 480);
    if (!display) return 0;
    lv_sdl_mouse_create();
    lv_sdl_mousewheel_create();
    screen_root = lv_screen_active();
    lv_obj_set_style_bg_color(screen_root, lv_color_hex(0x0d1719), 0);
    lv_obj_set_style_bg_opa(screen_root, LV_OPA_COVER, 0);
    emscripten_set_main_loop(render_tick, 0, 0);
    return 1;
}

EMSCRIPTEN_KEEPALIVE
void lvgl_bridge_reset(void) {
    if (screen_root) lv_obj_clean(screen_root);
    if (display) {
        lv_obj_clean(lv_display_get_layer_top(display));
        lv_obj_clean(lv_display_get_layer_bottom(display));
    }
}

EMSCRIPTEN_KEEPALIVE
lv_obj_t *lvgl_bridge_get_top_layer(void) {
    return display ? lv_display_get_layer_top(display) : NULL;
}

EMSCRIPTEN_KEEPALIVE
lv_obj_t *lvgl_bridge_get_bottom_layer(void) {
    return display ? lv_display_get_layer_bottom(display) : NULL;
}

EMSCRIPTEN_KEEPALIVE
void lvgl_bridge_update_layout(void) {
    if (screen_root) lv_obj_update_layout(screen_root);
    if (display) {
        lv_obj_update_layout(lv_display_get_layer_top(display));
        lv_obj_update_layout(lv_display_get_layer_bottom(display));
    }
}

static int object_coordinate(lv_obj_t *object, int coordinate) {
    if (!object) return 0;
    lv_area_t area;
    lv_obj_get_coords(object, &area);
    if (coordinate == 0) return area.x1;
    if (coordinate == 1) return area.y1;
    if (coordinate == 2) return area.x2 - area.x1 + 1;
    return area.y2 - area.y1 + 1;
}

EMSCRIPTEN_KEEPALIVE
int lvgl_bridge_get_obj_x(lv_obj_t *object) { return object_coordinate(object, 0); }

EMSCRIPTEN_KEEPALIVE
int lvgl_bridge_get_obj_y(lv_obj_t *object) { return object_coordinate(object, 1); }

EMSCRIPTEN_KEEPALIVE
int lvgl_bridge_get_obj_width(lv_obj_t *object) { return object_coordinate(object, 2); }

EMSCRIPTEN_KEEPALIVE
int lvgl_bridge_get_obj_height(lv_obj_t *object) { return object_coordinate(object, 3); }

EMSCRIPTEN_KEEPALIVE
void lvgl_bridge_configure_screen(int bg_color, int bg_opa, int border_width, int pad_all) {
    if (!screen_root) return;
    lv_obj_set_style_bg_color(screen_root, color_from_hex(bg_color), 0);
    lv_obj_set_style_bg_opa(screen_root, bg_opa, 0);
    lv_obj_set_style_border_width(screen_root, border_width, 0);
    lv_obj_set_style_pad_all(screen_root, pad_all, 0);
    lv_obj_clear_flag(screen_root, LV_OBJ_FLAG_SCROLLABLE);
}

EMSCRIPTEN_KEEPALIVE
void lvgl_bridge_configure_obj(lv_obj_t *object, const char *width, const char *height,
        int x, int y, const char *align, int bg_color, int bg_opa, int border_width,
    int radius, int pad_all, int text_color, int font_size, const char *font_id) {
    if (!object) return;
    lv_obj_set_size(object, size_from_text(width, LV_SIZE_CONTENT), size_from_text(height, LV_SIZE_CONTENT));
    lv_align_t alignment = align_from_text(align);
    if (alignment == LV_ALIGN_DEFAULT) lv_obj_set_pos(object, x, y);
    else lv_obj_align(object, alignment, x, y);
    if (bg_color >= 0) lv_obj_set_style_bg_color(object, color_from_hex(bg_color), 0);
    if (bg_opa >= 0) lv_obj_set_style_bg_opa(object, bg_opa, 0);
    if (border_width >= 0) lv_obj_set_style_border_width(object, border_width, 0);
    if (radius >= 0) lv_obj_set_style_radius(object, radius, 0);
    if (pad_all >= 0) lv_obj_set_style_pad_all(object, pad_all, 0);
    if (text_color >= 0) lv_obj_set_style_text_color(object, color_from_hex(text_color), 0);
    if ((font_id && font_id[0]) || font_size > 0) lv_obj_set_style_text_font(object, font_from_config(font_id, font_size), 0);
}

EMSCRIPTEN_KEEPALIVE
lv_obj_t *lvgl_bridge_create_obj(lv_obj_t *parent, int x, int y, int width, int height, int color) {
    lv_obj_t *object = lv_obj_create(parent ? parent : screen_root);
    lv_obj_set_pos(object, x, y);
    lv_obj_set_size(object, width > 0 ? width : LV_SIZE_CONTENT, height > 0 ? height : LV_SIZE_CONTENT);
    lv_obj_set_style_bg_color(object, color_from_hex(color), 0);
    lv_obj_set_style_bg_opa(object, LV_OPA_COVER, 0);
    return object;
}

EMSCRIPTEN_KEEPALIVE
lv_obj_t *lvgl_bridge_create_bar(lv_obj_t *parent, int x, int y, int width, int height, int minimum, int maximum, int value) {
    lv_obj_t *bar = lv_bar_create(parent ? parent : screen_root);
    lv_obj_set_pos(bar, x, y);
    lv_obj_set_size(bar, width > 0 ? width : 100, height > 0 ? height : 12);
    if (maximum <= minimum) maximum = minimum + 1;
    lv_bar_set_range(bar, minimum, maximum);
    lv_bar_set_value(bar, value, LV_ANIM_OFF);
    return bar;
}

EMSCRIPTEN_KEEPALIVE
lv_obj_t *lvgl_bridge_create_slider(lv_obj_t *parent, int x, int y, int width, int height, int minimum, int maximum, int value, int vertical) {
    lv_obj_t *slider = lv_slider_create(parent ? parent : screen_root);
    lv_obj_set_pos(slider, x, y);
    lv_obj_set_size(slider, width > 0 ? width : (vertical ? 20 : 100), height > 0 ? height : (vertical ? 100 : 20));
    if (maximum <= minimum) maximum = minimum + 1;
    lv_slider_set_range(slider, minimum, maximum);
    lv_slider_set_value(slider, value, LV_ANIM_OFF);
    return slider;
}

EMSCRIPTEN_KEEPALIVE
lv_obj_t *lvgl_bridge_create_label(lv_obj_t *parent, const char *text, int x, int y) {
    lv_obj_t *label = lv_label_create(parent ? parent : screen_root);
    lv_label_set_text(label, text ? text : "");
    lv_obj_set_style_text_color(label, lv_color_hex(0xdce7e3), 0);
    lv_obj_set_pos(label, x, y);
    return label;
}

EMSCRIPTEN_KEEPALIVE
lv_obj_t *lvgl_bridge_create_switch(lv_obj_t *parent, int x, int y, int width, int height, int checked) {
    lv_obj_t *switch_object = lv_switch_create(parent ? parent : screen_root);
    lv_obj_set_pos(switch_object, x, y);
    lv_obj_set_size(switch_object, width > 0 ? width : 50, height > 0 ? height : 25);
    lv_obj_set_style_bg_color(switch_object, lv_color_hex(0x596765), LV_PART_MAIN);
    lv_obj_set_style_bg_opa(switch_object, LV_OPA_COVER, LV_PART_MAIN);
    lv_obj_set_style_bg_color(switch_object, lv_color_hex(0x2a3b3d), LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(switch_object, LV_OPA_COVER, LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(switch_object, lv_color_hex(0xf4f7f5), LV_PART_KNOB);
    lv_obj_set_style_bg_opa(switch_object, LV_OPA_COVER, LV_PART_KNOB);
    lv_obj_set_style_bg_color(switch_object, lv_color_hex(0x36c5b3), LV_PART_INDICATOR | LV_STATE_CHECKED);
    if (checked) lv_obj_add_state(switch_object, LV_STATE_CHECKED);
    else lv_obj_remove_state(switch_object, LV_STATE_CHECKED);
    return switch_object;
}

EMSCRIPTEN_KEEPALIVE
lv_obj_t *lvgl_bridge_create_image(lv_obj_t *parent, const char *source_id, int x, int y, int width, int height) {
    registered_image_t *entry = registered_images;
    while (entry && strcmp(entry->id, source_id)) entry = entry->next;
    if (!entry) return lvgl_bridge_create_obj(parent, x, y, width, height, 0);
    lv_obj_t *image = lv_image_create(parent ? parent : screen_root);
    lv_image_set_src(image, &entry->descriptor);
    lv_obj_set_pos(image, x, y);
    lv_obj_set_size(image, width > 0 ? width : entry->descriptor.header.w, height > 0 ? height : entry->descriptor.header.h);
    lv_image_set_inner_align(image, LV_IMAGE_ALIGN_STRETCH);
    return image;
}

EMSCRIPTEN_KEEPALIVE
lv_obj_t *lvgl_bridge_create_button(lv_obj_t *parent, const char *text, int x, int y, int width, int height, int color) {
    lv_obj_t *button = lv_button_create(parent ? parent : screen_root);
    lv_obj_set_pos(button, x, y);
    lv_obj_set_size(button, width, height);
    lv_obj_set_style_bg_color(button, color_from_hex(color), 0);
    lv_obj_set_style_bg_opa(button, LV_OPA_COVER, 0);
    lv_obj_t *label = lv_label_create(button);
    lv_label_set_text(label, text ? text : "");
    lv_obj_center(label);
    return button;
}

EMSCRIPTEN_KEEPALIVE
void lvgl_bridge_set_text(lv_obj_t *object, const char *text) {
    if (object) lv_label_set_text(object, text ? text : "");
}

EMSCRIPTEN_KEEPALIVE
void lvgl_bridge_set_color(lv_obj_t *object, int color) {
    if (object) lv_obj_set_style_bg_color(object, color_from_hex(color), 0);
}

EMSCRIPTEN_KEEPALIVE
void lvgl_bridge_set_visible(lv_obj_t *object, int visible) {
    if (!object) return;
    if (visible) lv_obj_clear_flag(object, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(object, LV_OBJ_FLAG_HIDDEN);
}

EMSCRIPTEN_KEEPALIVE
void lvgl_bridge_set_scrollable(lv_obj_t *object, int scrollable) {
    if (!object) return;
    if (scrollable) lv_obj_add_flag(object, LV_OBJ_FLAG_SCROLLABLE);
    else lv_obj_clear_flag(object, LV_OBJ_FLAG_SCROLLABLE);
}

EMSCRIPTEN_KEEPALIVE
void lvgl_bridge_destroy(void) {
    if (display) {
        emscripten_cancel_main_loop();
        lv_display_delete(display);
        display = NULL;
        screen_root = NULL;
    }
}
