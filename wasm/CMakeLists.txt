cmake_minimum_required(VERSION 3.20)
project(walldisplay_lvgl LANGUAGES C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -O2 -sUSE_SDL=2")
set(LV_CONF_PATH "${CMAKE_CURRENT_LIST_DIR}/lv_conf.h" CACHE STRING "LVGL configuration" FORCE)

add_compile_definitions(LV_CONF_INCLUDE_SIMPLE)
include_directories("${CMAKE_CURRENT_LIST_DIR}")
include_directories("${CMAKE_CURRENT_LIST_DIR}/../third_party/lvgl")
add_subdirectory("${CMAKE_CURRENT_LIST_DIR}/../third_party/lvgl" "${CMAKE_BINARY_DIR}/lvgl")

add_executable(lvgl_runtime
    lvgl_bridge.c
)
target_link_libraries(lvgl_runtime PRIVATE lvgl)
target_link_options(lvgl_runtime PRIVATE
    "-O2"
    "-sUSE_SDL=2"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sENVIRONMENT=web"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sINITIAL_MEMORY=268435456"
    "-sEXPORTED_FUNCTIONS=['_malloc','_free','_lvgl_bridge_init','_lvgl_bridge_reset','_lvgl_bridge_get_top_layer','_lvgl_bridge_get_bottom_layer','_lvgl_bridge_update_layout','_lvgl_bridge_get_obj_x','_lvgl_bridge_get_obj_y','_lvgl_bridge_get_obj_width','_lvgl_bridge_get_obj_height','_lvgl_bridge_configure_screen','_lvgl_bridge_configure_obj','_lvgl_bridge_register_font','_lvgl_bridge_clear_fonts','_lvgl_bridge_register_image','_lvgl_bridge_clear_images','_lvgl_bridge_create_obj','_lvgl_bridge_create_bar','_lvgl_bridge_create_slider','_lvgl_bridge_create_label','_lvgl_bridge_create_switch','_lvgl_bridge_create_image','_lvgl_bridge_create_button','_lvgl_bridge_set_text','_lvgl_bridge_set_color','_lvgl_bridge_set_visible','_lvgl_bridge_set_scrollable','_lvgl_bridge_destroy']"
    "-sEXPORTED_RUNTIME_METHODS=['ccall','cwrap','writeArrayToMemory']"
)
set_target_properties(lvgl_runtime PROPERTIES SUFFIX ".js")
