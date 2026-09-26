package in.nxtwave.facultytrack;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Registered before super.onCreate, which builds the bridge and loads the site.
        registerPlugin(FileSaverPlugin.class);
        super.onCreate(savedInstanceState);

        // Back goes back a page, as it does in Chrome. Without this, Android's
        // default closed the app on the first press - from anywhere, including
        // a report opened from Daily Records - and the next open reloaded the
        // site from scratch.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = getBridge() == null ? null : getBridge().getWebView();
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    // Nowhere left to go back to: step aside rather than close,
                    // so reopening is instant and a kiosk tablet is not left on
                    // the home screen by a stray press being undone.
                    moveTaskToBack(true);
                }
            }
        });
    }
}
