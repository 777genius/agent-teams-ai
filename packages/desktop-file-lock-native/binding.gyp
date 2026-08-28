{
  "targets": [
    {
      "target_name": "desktop_file_lock_native",
      "sources": [
        "src/addon.cc",
        "src/platform_posix.cc",
        "src/platform_windows.cc"
      ],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='win'", {
          "msvs_settings": {
            "VCCLCompilerTool": {
              "AdditionalOptions": ["/std:c++17"]
            }
          }
        }, {
          "cflags_cc": ["-std=c++17", "-fexceptions"]
        }]
      ]
    }
  ]
}
