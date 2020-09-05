/**
 * @title Caisson ID Check
 * @overview Validate US driver's licenses and international passports in real time.
 * @gallery true
 * @category marketplace
 *
 * [Caisson Integration guide](https://www.caisson.com/docs/integration/auth0/)
 */

async function caissonIDCheck(user, context, callback) {
  const { Auth0RedirectRuleUtilities } = require("@auth0/rule-utilities@0.1.0");

  //copy off the config obj so we can use our own private key for session token signing.
  let caissonConf = JSON.parse(JSON.stringify(configuration));
  caissonConf.SESSION_TOKEN_SECRET = configuration.CAISSON_PRIVATE_KEY;

  const manager = {
    creds: {
      public_key: caissonConf.CAISSON_PUBLIC_KEY,
      private_key: caissonConf.CAISSON_PRIVATE_KEY,
    },
    debug:
      caissonConf.CAISSON_DEBUG &&
      caissonConf.CAISSON_DEBUG.toLowerCase() === "true"
        ? true
        : false,
    idCheckFlags: {
      on_registration:
        caissonConf.CAISSON_ON_REGISTRATION &&
        caissonConf.CAISSON_ON_REGISTRATION.toLowerCase() === "true"
          ? true
          : false,
      login_frequency_days: caissonConf.CAISSON_LOGIN_FREQUENCY_DAYS
        ? parseInt(caissonConf.CAISSON_LOGIN_FREQUENCY_DAYS)
        : 0,
    },
    caissonHosts: {
      idcheck: "https://id.caisson.com",
      api: "https://api.caisson.com",
      dashboard: "https://www.caisson.com",
    },
    axios: require("axios"),
    util: new Auth0RedirectRuleUtilities(user, context, caissonConf),
  };

  /**
   * Toggleable logger.  Set CAISSON_DEBUG in the Auth0 configuration to enable.
   *
   * @param {error} err
   */
  function dLog(err) {
    if (manager.debug) {
      console.log(err);
    }
  }

  /**
   * Helper function for converting milliseconds to days. Results rounded down.
   * @param {int} mils
   */
  function millisToDays(mils) {
    return Math.floor(mils / 1000 / 60 / 60 / 24);
  }

  /**
   * Creates Caisson specific session token and sets redirect url.
   */
  function setIDCheckRedirect() {
    const token = manager.util.createSessionToken({
      public_key: manager.creds.public_key,
      host: context.request.hostname,
      user_id: user.user_id,
    });

    //throws if redirects aren't allowed here.
    manager.util.doRedirect(`${manager.caissonHosts.idcheck}/auth0`, token); //throws
  }

  /**
   * Swaps the temp Caisson exchange token for an ID Check key.
   * https://www.caisson.com/docs/reference/api/#exchange-check-token-for-check-id
   * @param {string} t
   */
  async function exchangeToken(t) {
    try {
      let resp = await manager.axios.post(
        manager.caissonHosts.api + "/v1/idcheck/exchangetoken",
        { check_exchange_token: manager.util.queryParams.t },
        {
          headers: {
            Authorization: `Caisson ${manager.creds.private_key}`,
          },
        }
      );

      return resp.data.check_id;
    } catch (error) {
      let err = error;
      if (err.response && err.response.status === 401) {
        err = new Error(
          "Invalid private key.  See your API credentials at https://www.caisson.com/developer ."
        );
      }
      throw err;
    }
  }

  /**
   * Fetches and validates ID Check results.
   * https://www.caisson.com/docs/reference/api/#get-an-id-check-result
   * @param {string} check_id
   */
  async function idCheckResults(check_id) {
    try {
      let resp = await manager.axios.get(
        manager.caissonHosts.api + "/v1/idcheck",
        {
          headers: {
            Authorization: `Caisson ${manager.creds.private_key}`,
            "X-Caisson-CheckID": check_id,
          },
        }
      );

      if (resp.data.error) {
        throw new Error(
          "error in Caisson ID Check: " + JSON.stringify(resp.data)
        );
      }

      let results = {
        check_id: resp.data.check_id,
        auth0_id: resp.data.customer_id,
        timestamp: resp.data.checked_on,
        status:
          resp.data.confidence.document === "high" &&
          resp.data.confidence.face === "high"
            ? "passed"
            : "flagged",
      };

      validateIDCheck(results); //throws if invalid

      return results;
    } catch (error) {
      let err = error;
      if (err.response && err.response.status === 401) {
        err = new Error(
          "Invalid private key.  See your API credentials at https://www.caisson.com/developer ."
        );
      }

      throw err;
    }
  }

  /**
   * Validates Caisson ID Check results, ensuring the data is usable.
   * @param {object} results
   */
  function validateIDCheck(results) {
    const IDCheckTTL = 20 * 60 * 1000; //20 mins
    if (
      results.auth0_id !==
      user.user_id + "__" + manager.util.queryParams.state
    ) {
      throw new UnauthorizedError(
        "ID mismatch. Caisson: %o, Auth0: %o",
        results.auth0_id,
        user.user_id
      );
    } else if (Date.now() - Date.parse(results.timestamp) > IDCheckTTL) {
      throw new UnauthorizedError("ID Check too old.");
    } else if (results.status === "flagged") {
      throw new UnauthorizedError("ID Check flagged.");
    }
  }

  /**
   * Updates Caisson values on the Auth0 user object's app_metadata object.
   * @param {object} results
   */
  async function updateUser(results) {
    user.app_metadata = user.app_metadata || {};

    let caisson = user.app_metadata.caisson || {};
    caisson.idcheck_url =
      manager.caissonHosts.dashboard + "/request/" + results.check_id;
    caisson.status = results.status;
    caisson.last_check = Date.now();
    caisson.count = caisson.count ? caisson.count + 1 : 1;

    user.app_metadata.caisson = caisson;

    try {
      await auth0.users.updateAppMetadata(user.user_id, user.app_metadata);
    } catch (err) {
      throw err;
    }
  }

  /**
   * ID Check is done, handle results.
   */
  if (manager.util.isRedirectCallback) {
    //is it our redirect?
    if (!manager.util.queryParams.caisson_flow) {
      //no, end it.
      return callback(null, user, context);
    }

    try {
      if (!manager.util.queryParams.t) {
        throw new Error("Missing Caisson exchange key");
      }

      const check_id = await exchangeToken(manager.util.queryParams.t);
      const results = await idCheckResults(check_id);
      await updateUser(results);
    } catch (err) {
      dLog(err);
      return callback(err);
    }

    return callback(null, user, context);
  } else {
    /**
     * Perform ID Checks when appropriate
     */
    user.app_metadata = user.app_metadata || {};
    user.app_metadata.caisson = user.app_metadata.caisson || {};

    try {
      //registration
      if (
        manager.idCheckFlags.on_registration &&
        context.stats.loginsCount === 0
      ) {
        setIDCheckRedirect();
      }

      //all logins
      else if (manager.idCheckFlags.login_frequency_days === -1) {
        setIDCheckRedirect();
      }

      //login after period of days since last successful ID Check
      else if (
        manager.idCheckFlags.login_frequency_days > 0 &&
        (!user.app_metadata.caisson.last_check ||
          millisToDays(Date.now() - user.app_metadata.caisson.last_check)) >=
          manager.idCheckFlags.login_frequency_days
      ) {
        setIDCheckRedirect();
      } else {
        //otherwise, don't perform an ID Check
      }
    } catch (err) {
      dLog(err);
      return callback(err);
    }

    return callback(null, user, context);
  }
}
