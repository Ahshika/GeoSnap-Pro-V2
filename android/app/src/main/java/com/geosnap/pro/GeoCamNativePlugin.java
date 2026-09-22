package com.geosnap.pro;

import android.Manifest;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.provider.Settings;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Size;

import androidx.exifinterface.media.ExifInterface;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

@CapacitorPlugin(
    name = "GeoCamNative",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class GeoCamNativePlugin extends Plugin {

    private String torchCameraId = null;

    private String findTorchCameraId() {
        if (torchCameraId != null) return torchCameraId;
        try {
            CameraManager manager = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics chars = manager.getCameraCharacteristics(id);
                Boolean hasFlash = chars.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
                if (Boolean.TRUE.equals(hasFlash) && facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
                    torchCameraId = id;
                    return torchCameraId;
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    // Shares a photo already saved to MediaStore straight from its content:// URI via
    // ACTION_SEND - the standard, reliable way to hand a MediaStore item to any other app
    // (WhatsApp, Gmail, etc.). Deliberately not routed through @capacitor/share's `files`
    // option, which expects file:// paths and doesn't handle content:// URIs from MediaStore.
    @PluginMethod
    public void shareImage(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) {
            call.reject("Missing uri");
            return;
        }
        try {
            Intent sendIntent = new Intent(Intent.ACTION_SEND);
            sendIntent.setType("image/jpeg");
            sendIntent.putExtra(Intent.EXTRA_STREAM, Uri.parse(uriStr));
            sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(sendIntent, call.getString("title", "Share"));
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve(new JSObject());
        } catch (Exception e) {
            call.reject("Failed to share image: " + e.getMessage(), e);
        }
    }

    // Jumps straight to this app's permission screen in Android Settings, so a user whose
    // camera permission got stuck in a bad state (seen on some OEM WebViews) can toggle it
    // off/on without doing a full uninstall/reinstall.
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve(new JSObject());
        } catch (Exception e) {
            call.reject("Failed to open settings: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void hasFlash(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", findTorchCameraId() != null);
        call.resolve(ret);
    }

    // Toggles the rear flash unit's torch directly via Camera2, bypassing the WebView's
    // getUserMedia torch constraint (which hangs/no-ops on many OEM WebViews). This only
    // works while no other client (e.g. the live preview) holds an exclusive lock on the
    // same camera device, so callers must treat failure as "unsupported here" and fall back.
    @PluginMethod
    public void setTorch(PluginCall call) {
        boolean on = call.getBoolean("on", false);
        String id = findTorchCameraId();
        if (id == null) {
            call.reject("NO_FLASH");
            return;
        }
        try {
            CameraManager manager = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
            manager.setTorchMode(id, on);
            call.resolve(new JSObject());
        } catch (CameraAccessException e) {
            call.reject("CAMERA_IN_USE", e);
        } catch (Exception e) {
            call.reject("TORCH_FAILED", e);
        }
    }

    @PluginMethod
    public void getImageBase64(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) {
            call.reject("Missing uri");
            return;
        }
        try (InputStream is = getContext().getContentResolver().openInputStream(Uri.parse(uriStr))) {
            if (is == null) {
                call.reject("Could not open image");
                return;
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
            JSObject ret = new JSObject();
            ret.put("base64", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to read image: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void requestAllPermissions(PluginCall call) {
        String[] aliases = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            ? new String[]{ "camera", "location", "storage" }
            : new String[]{ "camera", "location" };
        requestPermissionForAliases(aliases, call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        reportPermissions(call);
    }

    @PluginMethod
    public void checkAllPermissions(PluginCall call) {
        reportPermissions(call);
    }

    private void reportPermissions(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("camera", getPermissionState("camera").toString().toLowerCase());
        ret.put("location", getPermissionState("location").toString().toLowerCase());
        call.resolve(ret);
    }

    @PluginMethod
    public void saveImage(PluginCall call) {
        String base64 = call.getString("base64");
        String fileName = call.getString("fileName", "GeoSnap_" + System.currentTimeMillis() + ".jpg");
        String album = call.getString("album", "GeoSnap Pro");

        if (base64 == null) {
            call.reject("Missing base64 image data");
            return;
        }

        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            Context ctx = getContext();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Images.Media.DISPLAY_NAME, fileName);
            values.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");

            Uri collection;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                values.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/" + album);
                values.put(MediaStore.Images.Media.IS_PENDING, 1);
                collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
            } else {
                collection = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
            }

            Uri itemUri = ctx.getContentResolver().insert(collection, values);
            if (itemUri == null) {
                call.reject("Could not create MediaStore entry");
                return;
            }

            try (OutputStream out = ctx.getContentResolver().openOutputStream(itemUri)) {
                if (out != null) out.write(bytes);
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues pendingDone = new ContentValues();
                pendingDone.put(MediaStore.Images.Media.IS_PENDING, 0);
                ctx.getContentResolver().update(itemUri, pendingDone, null, null);
            }

            JSObject ret = new JSObject();
            ret.put("uri", itemUri.toString());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to save image: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void saveDocument(PluginCall call) {
        String base64 = call.getString("base64");
        String fileName = call.getString("fileName", "GeoSnap_Report_" + System.currentTimeMillis() + ".pdf");
        if (base64 == null) {
            call.reject("Missing base64 document data");
            return;
        }
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            Context ctx = getContext();

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                values.put(MediaStore.Downloads.MIME_TYPE, "application/pdf");
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri itemUri = ctx.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (itemUri == null) {
                    call.reject("Could not create document entry");
                    return;
                }
                try (OutputStream out = ctx.getContentResolver().openOutputStream(itemUri)) {
                    if (out != null) out.write(bytes);
                }
                ContentValues pendingDone = new ContentValues();
                pendingDone.put(MediaStore.Downloads.IS_PENDING, 0);
                ctx.getContentResolver().update(itemUri, pendingDone, null, null);

                JSObject ret = new JSObject();
                ret.put("uri", itemUri.toString());
                call.resolve(ret);
            } else {
                File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!dir.exists()) dir.mkdirs();
                File file = new File(dir, fileName);
                try (OutputStream out = new FileOutputStream(file)) {
                    out.write(bytes);
                }
                android.media.MediaScannerConnection.scanFile(ctx, new String[]{ file.getAbsolutePath() }, null, null);
                JSObject ret = new JSObject();
                ret.put("uri", Uri.fromFile(file).toString());
                call.resolve(ret);
            }
        } catch (Exception e) {
            call.reject("Failed to save document: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void listImages(PluginCall call) {
        String album = call.getString("album", "GeoSnap Pro");
        int limit = call.getInt("limit", 60);
        Context ctx = getContext();
        JSArray items = new JSArray();

        Uri collection = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            ? MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;

        String[] projection = new String[]{
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DATE_ADDED
        };

        String selection = null;
        String[] selectionArgs = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            selection = MediaStore.Images.Media.RELATIVE_PATH + " LIKE ?";
            selectionArgs = new String[]{ "Pictures/" + album + "%" };
        }

        String sortOrder = MediaStore.Images.Media.DATE_ADDED + " DESC";

        try (Cursor cursor = ctx.getContentResolver().query(collection, projection, selection, selectionArgs, sortOrder)) {
            if (cursor != null) {
                int idCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media._ID);
                int dateCol = cursor.getColumnIndexOrThrow(MediaStore.Images.Media.DATE_ADDED);
                int count = 0;
                while (cursor.moveToNext() && count < limit) {
                    long id = cursor.getLong(idCol);
                    long dateAdded = cursor.getLong(dateCol);
                    Uri itemUri = Uri.withAppendedPath(collection, String.valueOf(id));

                    JSObject item = new JSObject();
                    item.put("id", String.valueOf(id));
                    item.put("uri", itemUri.toString());
                    item.put("dateAdded", dateAdded * 1000L);

                    try {
                        Bitmap thumb;
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            thumb = ctx.getContentResolver().loadThumbnail(itemUri, new Size(220, 220), null);
                        } else {
                            thumb = MediaStore.Images.Thumbnails.getThumbnail(ctx.getContentResolver(), id, MediaStore.Images.Thumbnails.MINI_KIND, null);
                        }
                        if (thumb != null) {
                            ByteArrayOutputStream bos = new ByteArrayOutputStream();
                            thumb.compress(Bitmap.CompressFormat.JPEG, 65, bos);
                            item.put("thumbnailBase64", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
                        }
                    } catch (Exception ignored) {}

                    try (InputStream is = ctx.getContentResolver().openInputStream(itemUri)) {
                        if (is != null) {
                            ExifInterface exif = new ExifInterface(is);
                            float[] latLng = new float[2];
                            if (exif.getLatLong(latLng)) {
                                item.put("lat", (double) latLng[0]);
                                item.put("lng", (double) latLng[1]);
                            }
                            String description = exif.getAttribute(ExifInterface.TAG_IMAGE_DESCRIPTION);
                            if (description != null && !description.isEmpty()) {
                                item.put("address", description);
                            }
                        }
                    } catch (Exception ignored) {}

                    items.put(item);
                    count++;
                }
            }
        } catch (Exception e) {
            call.reject("Failed to list images: " + e.getMessage(), e);
            return;
        }

        JSObject ret = new JSObject();
        ret.put("items", items);
        call.resolve(ret);
    }

    @PluginMethod
    public void deleteImage(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) {
            call.reject("Missing uri");
            return;
        }
        try {
            int rows = getContext().getContentResolver().delete(Uri.parse(uriStr), null, null);
            JSObject ret = new JSObject();
            ret.put("success", rows > 0);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to delete image: " + e.getMessage(), e);
        }
    }
}
