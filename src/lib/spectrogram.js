// acquired from https://www.arc.id.au/Spectrogram.html

/*=================================================================
  Filename: Spectrogram-2v01.js
  Rev: 2
  By: Dr A.R.Collins
  Description: JavaScript graphics functions to draw Spectrograms.

  Date    Description                                       By
  -------|----------------------------------------------------|---
  12Nov18 First beta                                           ARC
  17Nov18 Added offset into data buffer                        ARC
  08May19 this.imageURL URL added
          bugfix: fixed isNaN test
          Changed sgStart, sgStop to start, stop
          Added options object to constructors                 ARC
  10May19 Enabled Left to Right as well as Top to Bottom       ARC
  11May19 Added RasterscanSVG                                  ARC
  12May19 Added blankline for horizontal raster scans          ARC
  13May19 Eliminated unnecessary putImageData                  ARC
  14May19 Removed toDataURL, not used drawImage is better
          bugfix: SVG RHC names swapped                        ARC
  02Jun19 bugfix: startOfs not honored in horizontalNewLine    ARC
  03Jun19 Flipped the SVG and RHC names for waterfalls         ARC
  04Jun19 Unflip SVG and RHC for horizontal mode               ARC
          Swap "SVG" & "RHC" strings to match fn names         ARC
  05Jun19 bugfix: WaterfallSVG scrolling wrong way             ARC
  10Jun19 bugfix: support lineRate=0 for static display
          bugfix: ipBufPtr must be a ptr to a ptr              ARC
  11Jun19 Make ipBuffers an Array of Arrays, if lineRate=0
          use all buffers else use only ipBuffer[0]            ARC
  13Jun19 Use Waterfall and Rasterscan plus direction
          Use Boolean rather than string compare               ARC
  16Jun19 Use const and let                                    ARC
  20Jun19 Change order of parameters                           ARC
  21Jun19 Add setLineRate method                               ARC
  06Jul19 Released as Rev 1v00                                 ARC
  25Jul21 Refactor using class, arrow functions etc            
          Added RasterImage object
          Use object.buffer as input not array of arrays       ARC
  25Jul21 Released as Rev 2v00                                 ARC
 =================================================================*/

 export var Waterfall, Rasterscan, RasterImage;

 (function(){
   class Spectrogram {
     constructor(ipObj, w, h, sgMode, rhc, vert, options) {
       const opt = (typeof options === 'object')? options: {};   // avoid undeclared object errors
       const pxPerLine = w || 200;
       const lines = h || 200;
       const lineBuf = new ArrayBuffer(pxPerLine * 4); // 1 line
       const lineBuf8 = new Uint8ClampedArray(lineBuf);
       const lineImgData = new ImageData(lineBuf8, pxPerLine, 1);  // 1 line of canvas pixels
       const blankBuf = new ArrayBuffer(pxPerLine * 4); // 1 line
       const blankBuf8 = new Uint8ClampedArray(blankBuf);
       const blankImgData = new ImageData(blankBuf8, pxPerLine, 1);  // 1 line of canvas pixels
       const clearBuf = new ArrayBuffer(pxPerLine * lines * 4);  // fills with 0s ie. rgba 0,0,0,0 = transparent
       const clearBuf8 = new Uint8ClampedArray(clearBuf);
       let offScreenCtx;   // offscreen canvas drawing context
       let clearImgData;
       let lineRate = 30;  // requested line rate for dynamic waterfalls
       let interval = 0;   // msec
       let startOfs = 0;
       let nextLine = 0;
       let timerID = null;
       let running = false;
       let sgTime = 0;
       let sgStartTime = 0;
 
       // Matlab Jet ref: stackoverflow.com grayscale-to-red-green-blue-matlab-jet-color-scale
       let colMap = [[  0,   0, 128, 255], [  0,   0, 131, 255], [  0,   0, 135, 255], [  0,   0, 139, 255], 
                     [  0,   0, 143, 255], [  0,   0, 147, 255], [  0,   0, 151, 255], [  0,   0, 155, 255], 
                     [  0,   0, 159, 255], [  0,   0, 163, 255], [  0,   0, 167, 255], [  0,   0, 171, 255], 
                     [  0,   0, 175, 255], [  0,   0, 179, 255], [  0,   0, 183, 255], [  0,   0, 187, 255], 
                     [  0,   0, 191, 255], [  0,   0, 195, 255], [  0,   0, 199, 255], [  0,   0, 203, 255], 
                     [  0,   0, 207, 255], [  0,   0, 211, 255], [  0,   0, 215, 255], [  0,   0, 219, 255], 
                     [  0,   0, 223, 255], [  0,   0, 227, 255], [  0,   0, 231, 255], [  0,   0, 235, 255], 
                     [  0,   0, 239, 255], [  0,   0, 243, 255], [  0,   0, 247, 255], [  0,   0, 251, 255], 
                     [  0,   0, 255, 255], [  0,   4, 255, 255], [  0,   8, 255, 255], [  0,  12, 255, 255], 
                     [  0,  16, 255, 255], [  0,  20, 255, 255], [  0,  24, 255, 255], [  0,  28, 255, 255], 
                     [  0,  32, 255, 255], [  0,  36, 255, 255], [  0,  40, 255, 255], [  0,  44, 255, 255], 
                     [  0,  48, 255, 255], [  0,  52, 255, 255], [  0,  56, 255, 255], [  0,  60, 255, 255], 
                     [  0,  64, 255, 255], [  0,  68, 255, 255], [  0,  72, 255, 255], [  0,  76, 255, 255], 
                     [  0,  80, 255, 255], [  0,  84, 255, 255], [  0,  88, 255, 255], [  0,  92, 255, 255], 
                     [  0,  96, 255, 255], [  0, 100, 255, 255], [  0, 104, 255, 255], [  0, 108, 255, 255], 
                     [  0, 112, 255, 255], [  0, 116, 255, 255], [  0, 120, 255, 255], [  0, 124, 255, 255], 
                     [  0, 128, 255, 255], [  0, 131, 255, 255], [  0, 135, 255, 255], [  0, 139, 255, 255], 
                     [  0, 143, 255, 255], [  0, 147, 255, 255], [  0, 151, 255, 255], [  0, 155, 255, 255], 
                     [  0, 159, 255, 255], [  0, 163, 255, 255], [  0, 167, 255, 255], [  0, 171, 255, 255], 
                     [  0, 175, 255, 255], [  0, 179, 255, 255], [  0, 183, 255, 255], [  0, 187, 255, 255], 
                     [  0, 191, 255, 255], [  0, 195, 255, 255], [  0, 199, 255, 255], [  0, 203, 255, 255], 
                     [  0, 207, 255, 255], [  0, 211, 255, 255], [  0, 215, 255, 255], [  0, 219, 255, 255], 
                     [  0, 223, 255, 255], [  0, 227, 255, 255], [  0, 231, 255, 255], [  0, 235, 255, 255], 
                     [  0, 239, 255, 255], [  0, 243, 255, 255], [  0, 247, 255, 255], [  0, 251, 255, 255], 
                     [  0, 255, 255, 255], [  4, 255, 251, 255], [  8, 255, 247, 255], [ 12, 255, 243, 255], 
                     [ 16, 255, 239, 255], [ 20, 255, 235, 255], [ 24, 255, 231, 255], [ 28, 255, 227, 255], 
                     [ 32, 255, 223, 255], [ 36, 255, 219, 255], [ 40, 255, 215, 255], [ 44, 255, 211, 255], 
                     [ 48, 255, 207, 255], [ 52, 255, 203, 255], [ 56, 255, 199, 255], [ 60, 255, 195, 255], 
                     [ 64, 255, 191, 255], [ 68, 255, 187, 255], [ 72, 255, 183, 255], [ 76, 255, 179, 255], 
                     [ 80, 255, 175, 255], [ 84, 255, 171, 255], [ 88, 255, 167, 255], [ 92, 255, 163, 255], 
                     [ 96, 255, 159, 255], [100, 255, 155, 255], [104, 255, 151, 255], [108, 255, 147, 255], 
                     [112, 255, 143, 255], [116, 255, 139, 255], [120, 255, 135, 255], [124, 255, 131, 255], 
                     [128, 255, 128, 255], [131, 255, 124, 255], [135, 255, 120, 255], [139, 255, 116, 255], 
                     [143, 255, 112, 255], [147, 255, 108, 255], [151, 255, 104, 255], [155, 255, 100, 255], 
                     [159, 255,  96, 255], [163, 255,  92, 255], [167, 255,  88, 255], [171, 255,  84, 255], 
                     [175, 255,  80, 255], [179, 255,  76, 255], [183, 255,  72, 255], [187, 255,  68, 255], 
                     [191, 255,  64, 255], [195, 255,  60, 255], [199, 255,  56, 255], [203, 255,  52, 255], 
                     [207, 255,  48, 255], [211, 255,  44, 255], [215, 255,  40, 255], [219, 255,  36, 255], 
                     [223, 255,  32, 255], [227, 255,  28, 255], [231, 255,  24, 255], [235, 255,  20, 255], 
                     [239, 255,  16, 255], [243, 255,  12, 255], [247, 255,   8, 255], [251, 255,   4, 255], 
                     [255, 255,   0, 255], [255, 251,   0, 255], [255, 247,   0, 255], [255, 243,   0, 255], 
                     [255, 239,   0, 255], [255, 235,   0, 255], [255, 231,   0, 255], [255, 227,   0, 255], 
                     [255, 223,   0, 255], [255, 219,   0, 255], [255, 215,   0, 255], [255, 211,   0, 255], 
                     [255, 207,   0, 255], [255, 203,   0, 255], [255, 199,   0, 255], [255, 195,   0, 255], 
                     [255, 191,   0, 255], [255, 187,   0, 255], [255, 183,   0, 255], [255, 179,   0, 255], 
                     [255, 175,   0, 255], [255, 171,   0, 255], [255, 167,   0, 255], [255, 163,   0, 255], 
                     [255, 159,   0, 255], [255, 155,   0, 255], [255, 151,   0, 255], [255, 147,   0, 255], 
                     [255, 143,   0, 255], [255, 139,   0, 255], [255, 135,   0, 255], [255, 131,   0, 255], 
                     [255, 128,   0, 255], [255, 124,   0, 255], [255, 120,   0, 255], [255, 116,   0, 255], 
                     [255, 112,   0, 255], [255, 108,   0, 255], [255, 104,   0, 255], [255, 100,   0, 255], 
                     [255,  96,   0, 255], [255,  92,   0, 255], [255,  88,   0, 255], [255,  84,   0, 255], 
                     [255,  80,   0, 255], [255,  76,   0, 255], [255,  72,   0, 255], [255,  68,   0, 255], 
                     [255,  64,   0, 255], [255,  60,   0, 255], [255,  56,   0, 255], [255,  52,   0, 255], 
                     [255,  48,   0, 255], [255,  44,   0, 255], [255,  40,   0, 255], [255,  36,   0, 255], 
                     [255,  32,   0, 255], [255,  28,   0, 255], [255,  24,   0, 255], [255,  20,   0, 255], 
                     [255,  16,   0, 255], [255,  12,   0, 255], [255,   8,   0, 255], [255,   4,   0, 255], 
                     [255,   0,   0, 255], [251,   0,   0, 255], [247,   0,   0, 255], [243,   0,   0, 255], 
                     [239,   0,   0, 255], [235,   0,   0, 255], [231,   0,   0, 255], [227,   0,   0, 255], 
                     [223,   0,   0, 255], [219,   0,   0, 255], [215,   0,   0, 255], [211,   0,   0, 255], 
                     [207,   0,   0, 255], [203,   0,   0, 255], [199,   0,   0, 255], [195,   0,   0, 255], 
                     [191,   0,   0, 255], [187,   0,   0, 255], [183,   0,   0, 255], [179,   0,   0, 255], 
                     [175,   0,   0, 255], [171,   0,   0, 255], [167,   0,   0, 255], [163,   0,   0, 255], 
                     [159,   0,   0, 255], [155,   0,   0, 255], [151,   0,   0, 255], [147,   0,   0, 255], 
                     [143,   0,   0, 255], [139,   0,   0, 255], [135,   0,   0, 255], [131,   0,   0, 255],
                     [  0,   0,   0,   0]];
 
       const incrLine = ()=>
       {
         if ((vert && !rhc) || (!vert && rhc))
         {  
           nextLine++;
           if (nextLine >= lines)
           {
             nextLine = 0;
           }
         }
         else
         {
           nextLine--;
           if (nextLine < 0)
           {
             nextLine = lines-1;
           }
         }
       }
 
       const updateWaterfall = ()=>  // update dynamic waterfalls at a fixed rate
       {
         let sgDiff;
         
         // grab latest line of data, write it to off screen buffer, inc 'nextLine'
         this.newLine();
         // loop to write data data at the desired rate, data is being updated asynchronously
         // ref for accurate timeout: http://www.sitepoint.com/creating-accurate-timers-in-javascript
         sgTime += interval;
         sgDiff = (Date.now() - sgStartTime) - sgTime;
         if (running) 
         {
           timerID = setTimeout(updateWaterfall, interval - sgDiff);
         }
       }
 
       const setProperty = (propertyName, value)=>
       {
         if ((typeof propertyName !== "string")||(value === undefined))  // null is OK, forces default
         {
           return;
         }
         switch (propertyName.toLowerCase())
         {
           case "linerate":
             this.setLineRate(value);  // setLine does checks for number etc
           break;
           case "startbin":
             if (!isNaN(value) && value > 0)
             {
               startOfs = value;
             }
           break;
           case "onscreenparentid":
             if (typeof value === "string" && document.getElementById(value))
             {
               demoCvsId = value;
             }
             break;
           case "colormap":
             if (Array.isArray(value) && Array.isArray(value[0]) && value[0].length == 4)
             {
               colMap = value; // value must be an array of 4 element arrays to get here
               if (colMap.length<256)  // fill out the remaining colors with last color
               {
                 for (let i=colMap.length; i<256; i++)
                 {
                   colMap[i] = colMap[colMap.length-1];
                 }
               }
             }
           break;
           default:
           break;
         }
       }
         
       const verticalNewLine = ()=> 
       {
         let tmpImgData, ipBuf8;
         
         if (sgMode == "WF")
         {
           if (rhc)
           {
             // shift the current display down 1 line, oldest line drops off
             tmpImgData = offScreenCtx.getImageData(0, 0, pxPerLine, lines-1);
             offScreenCtx.putImageData(tmpImgData, 0, 1);
           }
           else
           {
             // shift the current display up 1 line, oldest line drops off
             tmpImgData = offScreenCtx.getImageData(0, 1, pxPerLine, lines-1);
             offScreenCtx.putImageData(tmpImgData, 0, 0);
           }
         }
         ipBuf8 = Uint8ClampedArray.from(ipObj.buffer);
         for (let sigVal, rgba, opIdx = 0, ipIdx = startOfs; ipIdx < pxPerLine+startOfs; opIdx += 4, ipIdx++) 
         {
           sigVal = ipBuf8[ipIdx] || 0;    // if input line too short add zeros
           rgba = colMap[sigVal];  // array of rgba values
           // byte reverse so number aa bb gg rr
           lineBuf8[opIdx] = rgba[0];   // red
           lineBuf8[opIdx+1] = rgba[1]; // green
           lineBuf8[opIdx+2] = rgba[2]; // blue
           lineBuf8[opIdx+3] = rgba[3]; // alpha
         }
         offScreenCtx.putImageData(lineImgData, 0, nextLine);
         if (sgMode === "RS")
         {
           incrLine();
           // if not static draw a white line in front of the current line to indicate new data point
           if (lineRate) 
           {
             offScreenCtx.putImageData(blankImgData, 0, nextLine);
           }
         }
       }
 
       const horizontalNewLine = ()=>  
       {
         let tmpImgData, ipBuf8;
 
           if (sgMode == "WF")
         {
           if (rhc)
           {
             // shift the current display right 1 line, oldest line drops off
             tmpImgData = offScreenCtx.getImageData(0, 0, lines-1, pxPerLine);
             offScreenCtx.putImageData(tmpImgData, 1, 0);
           }
           else
           {
             // shift the current display left 1 line, oldest line drops off
             tmpImgData = offScreenCtx.getImageData(1, 0, lines-1, pxPerLine);
             offScreenCtx.putImageData(tmpImgData, 0, 0);
           }
         }
         // refresh the page image (it was just shifted)
         const pageImgData = offScreenCtx.getImageData(0, 0, lines, pxPerLine);     
         if (ipObj.buffer.constructor !== Uint8Array)
         {
           ipBuf8 = Uint8ClampedArray.from(ipObj.buffer); // clamp input values to 0..255 range
         } 
         else
         {
           ipBuf8 = ipObj.buffer;  // conversion already done
         }
 
         for (let sigVal, rgba, opIdx, ipIdx=0; ipIdx < pxPerLine; ipIdx++) 
         {
           sigVal = ipBuf8[ipIdx+startOfs] || 0;    // if input line too short add zeros
           rgba = colMap[sigVal];  // array of rgba values
           opIdx = 4*((pxPerLine-ipIdx-1)*lines+nextLine);
           // byte reverse so number aa bb gg rr
           pageImgData.data[opIdx] = rgba[0];   // red
           pageImgData.data[opIdx+1] = rgba[1]; // green
           pageImgData.data[opIdx+2] = rgba[2]; // blue
           pageImgData.data[opIdx+3] = rgba[3]; // alpha
         }
         if (sgMode === "RS")
         {
           incrLine();
           // if not draw a white line in front of the current line to indicate new data point
           if (lineRate) 
           {
             for (let j=0; j < pxPerLine; j++) 
             {
               let opIdx;
               if (rhc)
               {
                 opIdx = 4*(j*lines+nextLine);
               }
               else
               {
                 opIdx = 4*((pxPerLine-j-1)*lines+nextLine);
               }
               // byte reverse so number aa bb gg rr
               pageImgData.data[opIdx] = 255;   // red
               pageImgData.data[opIdx+1] = 255; // green
               pageImgData.data[opIdx+2] = 255; // blue
               pageImgData.data[opIdx+3] = 255; // alpha
             }
           }
         } 
         offScreenCtx.putImageData(pageImgData, 0, 0);
       }
 
       const createOffScreenCanvas = ()=>
       {
         const cvs  = document.createElement("canvas");
         if (vert)
         {
           cvs.setAttribute('width', pxPerLine);   // reset canvas pixels width
           cvs.setAttribute('height', lines);      // don't use style for this
           clearImgData = new ImageData(clearBuf8, pxPerLine, lines);
         }
         else // data written in columns
         {
           cvs.setAttribute('width', lines);       // reset canvas pixels width
           cvs.setAttribute('height', pxPerLine);  // don't use style for this
           clearImgData = new ImageData(clearBuf8, lines, pxPerLine);
         }
         offScreenCtx = cvs.getContext("2d");
 
         return cvs;
       }
 
   // ===== now make the exposed properties and methods ===============
 
       this.newLine = (vert)? verticalNewLine: horizontalNewLine;  // function pointers
         
       this.offScreenCvs = createOffScreenCanvas();
 
       this.setLineRate = function sgSetLineRate(newRate)
       {
         if (isNaN(newRate) || newRate > 50 || newRate < 0)
         {
           console.error("invalid line rate [0 <= lineRate < 50 lines/sec]");
           // don't change the lineRate;
         }
         else if (newRate === 0)  // static (one pass) raster
         {
           lineRate = 0;
         }
         else
         {
           lineRate = newRate;
           interval = 1000/lineRate;  // msec
         }
       };
 
       this.clear = function()
       {
         offScreenCtx.putImageData(clearImgData, 0, 0);
       };
 
       this.start = function()
       {
         sgStartTime = Date.now();   
         sgTime = 0;
         running = true;
         updateWaterfall();  // start the update loop
       };
 
       this.stop = function()
       {
         running = false;
         if (timerID)
         {
           clearTimeout(timerID);
         }
         // reset where the next line is to be written
         if (sgMode === "RS")
         {
           if (vert)
           {
             nextLine = (rhc)? lines-1 : 0;
           }
           else
           {
             nextLine = (rhc)? 0 : lines-1;
           }
         }
         else // WF
         {
           nextLine = (rhc)? 0 :  lines-1;  
         }
       };
 
       //===== set all the options  ================
       for (let prop in opt)
       {
         // check that this is opt's own property, not inherited from prototype
         if (opt.hasOwnProperty(prop))
         {
           setProperty(prop, opt[prop]);
         }
       }
 
       // make a white line, it will show the input line for RS displays
       blankBuf8.fill(255);
       // make a full canvas of the color map 0 values
       for (let i=0; i<pxPerLine*lines*4; i+=4) 
       {
         // byte reverse so number aa bb gg rr
         clearBuf8[i] = colMap[0][0];   // red
         clearBuf8[i+1] = colMap[0][1]; // green
         clearBuf8[i+2] = colMap[0][2]; // blue
         clearBuf8[i+3] = colMap[0][3]; // alpha
       }
       // for diagnostics only
       if (typeof(demoCvsId) == "string")
       {
         document.getElementById(demoCvsId).appendChild(this.offScreenCvs); 
       }
       // initialize the direction and first line position
       this.stop();
 
       // everything is set 
       // if dynamic, wait for the start or newLine methods to be called
     }
   }
 
   Waterfall = class extends Spectrogram
   {
     constructor(ipObj, w, h, dir, options)   // ipObj = {buffer: [..]}
     {
       var direction = (typeof(dir) === "string")? dir.toLowerCase() : "down";
 
       switch (direction)
       {
         case "up":
           super(ipObj, w, h, "WF", false, true, options);
           break;
         case "down":
         default:
           super(ipObj, w, h, "WF", true, true, options);
           break;
         case "left":
           super(ipObj, w, h, "WF", false, false, options);
           break;
         case "right":
           super(ipObj, w, h, "WF", true, false, options);
           break;
       }
     }
   }
 
   Rasterscan = class extends Spectrogram
   {
     constructor(ipObj, w, h, dir, options)   // ipObj = {buffer: [..]}
     {
       const direction = (typeof(dir) === "string")? dir.toLowerCase() : "down";
 
       switch (direction)
       {
         case "up":
           super(ipObj, w, h, "RS", true, true, options);
           break;
         case "down":
         default:
           super(ipObj, w, h, "RS", false, true, options);
           break;
         case "left":
           super(ipObj, w, h, "RS", false, false, options);
           break;
         case "right":
           super(ipObj, w, h, "RS", true, false, options);    
           break;
       }
     }
   }
 
   RasterImage = class
   {
     constructor(dataBuf, cols, rows, options={})  // dataBuf = Array[rows][cols]
     {
       const ipObj = {buffer:null};
       const dirs = ["up", "down", "left"];
       let direction = "down";
       let dirLC;
 
       if (options.hasOwnProperty("dir") && typeof(options.dir)==="string")
       {
         dirLC = options.dir.toLowerCase();
       }
       else if (options.hasOwnProperty("direction") && typeof(options.direction)==="string")
       {
         dirLC = options.direction.toLowerCase();
       }
       if (dirLC && dirs.includes(dirLC))
         direction = dirLC;
 
       // dataBuf values are each an index (0..255) into a colorMap
       // Each  of 256 colorMap entries holds the 4 values RGBA each (0..255) of a color
 
       // force static image
       options.lineRate = 0;
       const raster =  new Rasterscan(ipObj, cols, rows, direction, options);
 
       // now build a raster display line by line
       for (let r=0; r<rows; r++)
       {
         ipObj.buffer = dataBuf[r];
         raster.newLine();
       }
 
       return raster.offScreenCvs;
     }
   }
 
 }())