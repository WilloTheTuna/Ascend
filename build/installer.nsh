!macro customInit
  nsExec::Exec 'taskkill /F /IM Ascend.exe /T'
  
  InitPluginsDir
  File /oname=$PLUGINSDIR\splash.bmp "${BUILD_RESOURCES_DIR}\splash.bmp"
  splash::show 2000 $PLUGINSDIR\splash.bmp
  Pop $0
!macroend
