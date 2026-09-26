package in.nxtwave.facultytrack;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Saves a file the page builds - the Daily Records CSV export.
 *
 * A browser downloads a blob link by itself; the app's WebView has no
 * download manager, so the same button did nothing in the app. The page calls
 * this instead when it is running inside the app.
 *
 * Android 10 and later: straight into Downloads, which needs no permission.
 * Android 7 to 9: writing to Downloads needs a storage permission, so the
 * file is handed to the share sheet, from where it can be saved to Files or
 * Drive, or sent by mail.
 */
@CapacitorPlugin(name = "FileSaver")
public class FileSaverPlugin extends Plugin {

    /** Well above any export the table can produce; a guard, not a quota. */
    private static final int MAX_BYTES = 25 * 1024 * 1024;

    @PluginMethod
    public void saveText(PluginCall call) {
        String content = call.getString("content");
        if (content == null) {
            call.reject("Nothing to save.");
            return;
        }
        byte[] bytes = content.getBytes(StandardCharsets.UTF_8);
        if (bytes.length > MAX_BYTES) {
            call.reject("The file is too large to save.");
            return;
        }
        String fileName = safeFileName(call.getString("fileName", "export.csv"));
        String mimeType = call.getString("mimeType", "text/plain");

        try {
            JSObject result = new JSObject();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveToDownloads(fileName, mimeType, bytes);
                toast("Saved to Downloads: " + fileName);
                result.put("savedTo", "downloads");
            } else {
                share(fileName, mimeType, bytes);
                result.put("savedTo", "share");
            }
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not save " + fileName + ".", error);
        }
    }

    private void saveToDownloads(String fileName, String mimeType, byte[] bytes) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
        values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        // Hidden from other apps until it is completely written.
        values.put(MediaStore.Downloads.IS_PENDING, 1);
        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("Downloads is not available.");
        try (OutputStream out = resolver.openOutputStream(uri)) {
            if (out == null) throw new IOException("Downloads is not writable.");
            out.write(bytes);
        } catch (IOException error) {
            resolver.delete(uri, null, null);
            throw error;
        }
        values.clear();
        values.put(MediaStore.Downloads.IS_PENDING, 0);
        resolver.update(uri, values, null, null);
    }

    private void share(String fileName, String mimeType, byte[] bytes) throws IOException {
        File directory = new File(getContext().getCacheDir(), "exports");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("No space for the file.");
        File file = new File(directory, fileName);
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(bytes);
        }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        Intent send = new Intent(Intent.ACTION_SEND)
            .setType(mimeType)
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().startActivity(Intent.createChooser(send, "Save " + fileName));
    }

    private void toast(String message) {
        getActivity().runOnUiThread(() -> Toast.makeText(getContext(), message, Toast.LENGTH_LONG).show());
    }

    /** A name, never a path: the page chooses what the file is called, not where it goes. */
    private static String safeFileName(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (cleaned.isEmpty() || cleaned.startsWith(".")) cleaned = "export" + cleaned;
        return cleaned.length() > 120 ? cleaned.substring(cleaned.length() - 120) : cleaned;
    }
}
