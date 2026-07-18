# SFML 2.6 assumes CGDisplayModeCopyPixelEncoding always returns a string.
# macOS 26 can return null for modern display modes, causing a startup crash.
if(NOT DEFINED SFML_CG_CONVERSION_FILE OR NOT EXISTS "${SFML_CG_CONVERSION_FILE}")
    message(FATAL_ERROR "Could not locate SFML's macOS display conversion source.")
endif()

file(READ "${SFML_CG_CONVERSION_FILE}" sfml_conversion_source)
string(FIND "${sfml_conversion_source}" "if (pixEnc == NULL)" already_patched)
if(NOT already_patched EQUAL -1)
    string(REPLACE
        "CGDisplayModeCopyPixelEncoding(mode)\n    if (pixEnc == NULL)"
        "CGDisplayModeCopyPixelEncoding(mode);\n    if (pixEnc == NULL)"
        repaired_source
        "${sfml_conversion_source}")
    string(REPLACE
        "return 32 // macOS 26"
        "return 32; // macOS 26"
        repaired_source
        "${repaired_source}")
    if(NOT repaired_source STREQUAL sfml_conversion_source)
        file(WRITE "${SFML_CG_CONVERSION_FILE}" "${repaired_source}")
        message(STATUS "Repaired SFML macOS compatibility patch")
    endif()
    return()
endif()

set(original_line "    CFStringRef pixEnc = CGDisplayModeCopyPixelEncoding(mode);\n")
string(ASCII 59 semicolon)
string(CONCAT patched_block
    "    CFStringRef pixEnc = CGDisplayModeCopyPixelEncoding(mode)" "${semicolon}" "\n"
    "    if (pixEnc == NULL)\n"
    "        return 32" "${semicolon}" " // macOS 26 may omit the legacy encoding, current displays are 32-bit.\n")
string(REPLACE "${original_line}" "${patched_block}" patched_source "${sfml_conversion_source}")

if(patched_source STREQUAL sfml_conversion_source)
    message(FATAL_ERROR "SFML macOS compatibility patch no longer matches the upstream source.")
endif()

file(WRITE "${SFML_CG_CONVERSION_FILE}" "${patched_source}")
message(STATUS "Applied SFML 2.6 macOS 26 display compatibility patch")
